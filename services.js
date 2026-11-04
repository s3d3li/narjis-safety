(function(){'use strict';var modules={"./supabase-auth-adapter.cjs":function(module,exports,require){
'use strict';
// Integration contract only. Not imported or initialized by the offline HTML.
// Inject an already configured TEST client later. Never pass a service key.
function grantError(result){
  const error=Error('VIEWER_CODE_REQUEST_FAILED');error.code=result.error.code==='42501'?'FORBIDDEN':'STORAGE';return error;
}
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
    // Viewer code management. Every RPC re-checks is_site_admin on the server.
    async issueViewerCode(label,expiresAt){
      const result=await client.rpc('issue_viewer_code',{p_label:label,p_expires_at:expiresAt});
      if(result.error) throw grantError(result);
      const data=result.data||{};
      if(!/^\d{6}$/.test(String(data.code||''))) throw Error('VIEWER_CODE_REQUEST_FAILED');
      return data;
    },
    async listViewerCodes(){
      const result=await client.rpc('list_viewer_codes');
      if(result.error) throw grantError(result);
      return Array.isArray(result.data)?result.data:[];
    },
    async revokeViewerCode(id){
      const result=await client.rpc('revoke_viewer_code',{p_id:id});
      if(result.error) throw grantError(result);
    },
    async viewerLockStatus(){
      const result=await client.rpc('viewer_lock_status');
      if(result.error) throw grantError(result);
      return result.data||{locked:false,failures:0};
    },
    async unlockViewerCodes(){
      const result=await client.rpc('unlock_viewer_codes');
      if(result.error) throw grantError(result);
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
"./supabase-viewer-adapter.cjs":function(module,exports,require){
'use strict';
// Viewer path: a 6-digit code becomes a short viewing session. No Auth account; the anon key only.
// The session token lives in memory (and the tab's sessionStorage via the UI); the server re-checks it on every call.
function createSupabaseViewerAdapter(client,validate){
  const SESSION=/^[0-9a-f]{64}$/;
  function denied(){const error=Error('VIEWER_SESSION_DENIED');error.code='FORBIDDEN';return error;}
  return {
    async redeem(code){
      if(!/^\d{6}$/.test(String(code||''))) return {ok:false,reason:'invalid'};
      const result=await client.rpc('redeem_viewer_code',{p_code:String(code)});
      if(result.error) throw Error('VIEWER_REDEEM_FAILED');
      const data=result.data||{};
      if(data.ok!==true) return {ok:false,reason:['locked','rate_limited','invalid'].indexOf(data.reason)>=0?data.reason:'invalid'};
      if(!SESSION.test(String(data.session||''))) throw Error('VIEWER_REDEEM_FAILED');
      return {ok:true,session:data.session,expiresAt:typeof data.expires_at==='string'?data.expires_at:null};
    },
    async load(session){
      if(!SESSION.test(String(session||''))) throw denied();
      const result=await client.rpc('read_app_state_viewer',{p_session:session});
      if(result.error){if(result.error.code==='42501') throw denied();throw Error('VIEWER_READ_FAILED');}
      const row=result.data;
      if(!row || !row.data) throw Error('STATE_NOT_INITIALIZED');
      validate(row.data);
      return JSON.parse(JSON.stringify(row.data));
    },
    async status(session){
      if(!SESSION.test(String(session||''))) return {active:false,expiresAt:null};
      const result=await client.rpc('viewer_session_status',{p_session:session});
      if(result.error) throw Error('VIEWER_STATUS_FAILED');
      const data=result.data||{};
      return {active:data.active===true,expiresAt:typeof data.expires_at==='string'?data.expires_at:null};
    },
    async end(session){
      if(!SESSION.test(String(session||''))) return;
      await client.rpc('end_viewer_session',{p_session:session});
    }
  };
}
module.exports={createSupabaseViewerAdapter};

},
"./supabase-services.cjs":function(module,exports,require){
'use strict';
const {createSupabaseAuthAdapter}=require('./supabase-auth-adapter.cjs');
const {createSupabaseStateAdapter}=require('./supabase-state-adapter.cjs');
const {createSupabasePublicAdapter}=require('./supabase-public-adapter.cjs');
const {createSupabaseViewerAdapter}=require('./supabase-viewer-adapter.cjs');
// Build/bundle for an approved environment later. No initialization in offline index.html.
function createSupabaseServices(client,validation){
  const auth=createSupabaseAuthAdapter(client);
  return {auth,state:createSupabaseStateAdapter(client,auth,validation.state),
    public:createSupabasePublicAdapter(client,validation.publicText),
    viewer:createSupabaseViewerAdapter(client,validation.state)};
}
module.exports={createSupabaseServices};

}},cache={};function require(id){if(!modules[id])throw Error('MODULE_DENIED');if(!cache[id]){var m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);}return cache[id].exports;}Object.defineProperty(window,'NARJIS_CREATE_SUPABASE_SERVICES',{value:require('./supabase-services.cjs').createSupabaseServices});})();
