(function(){'use strict';var modules={"./supabase-auth-adapter.cjs":function(module,exports,require){
'use strict';
// Integration contract only. Not imported or initialized by the offline HTML.
// Inject an already configured TEST client later. Never pass a service key.
function createSupabaseAuthAdapter(client){
  if(!client || !client.auth || typeof client.rpc!=='function') throw Error('AUTH_ADAPTER_REQUIRED');
  return {
    async signIn(email,password){
      const result=await client.auth.signInWithPassword({email,password});
      if(result.error) throw Error('SIGN_IN_DENIED');
    },
    async getUser(){
      const result=await client.auth.getUser(); // Verified by Auth, not getSession/user_metadata.
      if(result.error) throw Error('IDENTITY_UNVERIFIED');
      return result.data && result.data.user || null;
    },
    async isApprovedAdmin(userId){
      const verified=await this.getUser();
      if(!verified || verified.id!==userId) return false;
      const result=await client.rpc('is_site_admin'); // Server uses auth.uid(), never caller's role claim.
      if(result.error) throw Error('APPROVAL_UNVERIFIED');
      return result.data===true;
    },
    async signOut(){
      const result=await client.auth.signOut();
      if(result.error) throw Error('SIGN_OUT_FAILED');
    },
    onIdentityChange(revoke){
      return client.auth.onAuthStateChange(function(event,session){
        revoke(event,session && session.user && session.user.id || null);
      });
    }
  };
}
module.exports={createSupabaseAuthAdapter};

},
"./supabase-state-adapter.cjs":function(module,exports,require){
'use strict';
// No client creation, SDK loading, URLs or credentials. Tests inject an in-memory client.
function createSupabaseStateAdapter(client,auth,validate){
  let revision=null,blocked=false,inFlight=false;
  async function requireAdmin(){
    let allowed=false;
    try{const user=await auth.getUser();allowed=!!user && await auth.isApprovedAdmin(user.id)===true;}catch{}
    if(!allowed){
      const error=Error('ADMIN_REQUIRED');error.code='FORBIDDEN';throw error;
    }
  }
  function failure(result){
    if(!result.error)return;
    const code=result.error.code;
    const error=Error(code==='40001'?'STATE_CONFLICT':code==='42501'?'ADMIN_REQUIRED':'STATE_REQUEST_FAILED');
    error.code=code==='40001'?'CONFLICT':code==='42501'?'FORBIDDEN':'STORAGE';
    if(error.code==='CONFLICT')blocked=true;
    throw error;
  }
  return {
    kind:'remote',
    async load(){
      revision=null;blocked=true;
      await requireAdmin();
      const result=await client.rpc('read_app_state');failure(result);
      const row=result.data;
      if(!row || !Number.isSafeInteger(row.revision) || row.revision<1){
        revision=null;throw Error('STATE_NOT_INITIALIZED');
      }
      validate(row.data);revision=row.revision;blocked=false;
      return JSON.parse(JSON.stringify(row.data));
    },
    async save(snapshot){
      if(inFlight)throw Error('SAVE_IN_PROGRESS');
      if(revision===null)throw Error('LOAD_REQUIRED');
      if(blocked){const error=Error('RELOAD_AFTER_CONFLICT');error.code='CONFLICT';throw error;}
      validate(snapshot);inFlight=true;
      try{
        await requireAdmin();
        let result;
        try{result=await client.rpc('save_app_state',{p_data:snapshot,p_expected_revision:revision});}
        catch{blocked=true;const error=Error('SAVE_RESULT_UNKNOWN_RELOAD_REQUIRED');error.code='CONFLICT';throw error;}
        failure(result);
        if(!Number.isSafeInteger(result.data) || result.data!==revision+1){
          blocked=true;const error=Error('AMBIGUOUS_SAVE_RESULT');error.code='CONFLICT';throw error;
        }
        revision=result.data;return {revision};
      }finally{inFlight=false;}
    },
    async clear(){throw Error('REMOTE_RESET_DISABLED');},
    getRevision(){return revision;}
  };
}
module.exports={createSupabaseStateAdapter};

},
"./supabase-public-adapter.cjs":function(module,exports,require){
'use strict';
// Public data has a separate API surface. Never select app_state/app_config for a visitor.
function createSupabasePublicAdapter(client,validateText){
  return {
    async load(){
      const result=await client.from('safety_public_sections').select('section_id,body').eq('published',true);
      if(result.error)throw Error('PUBLIC_READ_FAILED');
      const content={};
      for(const row of result.data||[]){
        if(!Number.isInteger(row.section_id) || row.section_id<1 || row.section_id>19 || !validateText(row.body))
          throw Error('PUBLIC_CONTENT_REJECTED');
        content[row.section_id]=row.body;
      }
      return content;
    },
    async save(id,text,approved){
      if(approved!==true || !Number.isInteger(id) || id<1 || id>19 || !validateText(text))throw Error('PUBLIC_CONTENT_REJECTED');
      // Server RPC checks membership again. No general authenticated table writes.
      const result=await client.rpc('publish_safety_section',{p_section_id:id,p_body:text});
      if(result.error){const error=Error('PUBLIC_WRITE_DENIED');error.code=result.error.code==='42501'?'FORBIDDEN':'STORAGE';throw error;}
    }
  };
}
module.exports={createSupabasePublicAdapter};

},
"./supabase-services.cjs":function(module,exports,require){
'use strict';
const {createSupabaseAuthAdapter}=require('./supabase-auth-adapter.cjs');
const {createSupabaseStateAdapter}=require('./supabase-state-adapter.cjs');
const {createSupabasePublicAdapter}=require('./supabase-public-adapter.cjs');
// Build/bundle for an approved environment later. No initialization in offline index.html.
function createSupabaseServices(client,validation){
  const auth=createSupabaseAuthAdapter(client);
  return {auth,state:createSupabaseStateAdapter(client,auth,validation.state),
    public:createSupabasePublicAdapter(client,validation.publicText)};
}
module.exports={createSupabaseServices};

}},cache={};function require(id){if(!modules[id])throw Error('MODULE_DENIED');if(!cache[id]){var m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);}return cache[id].exports;}Object.defineProperty(window,'NARJIS_CREATE_SUPABASE_SERVICES',{value:require('./supabase-services.cjs').createSupabaseServices});})();
