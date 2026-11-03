(function(){
  'use strict';
  // Production transport guard: the page may reach only the production Supabase project, on the reviewed routes.
  var ORIGIN='https://uzltfiihrikmlmylxoeu.supabase.co';
  if(window.location.protocol!=='https:')throw Error('PRODUCTION_HTTPS_REQUIRED');
  var transport=window.fetch.bind(window);
  var routes={
    '/auth/v1/token':['POST'],'/auth/v1/user':['GET'],'/auth/v1/logout':['POST'],
    '/rest/v1/safety_public_sections':['GET'],'/rest/v1/rpc/is_site_admin':['POST'],
    '/rest/v1/rpc/read_app_state':['POST'],'/rest/v1/rpc/save_app_state':['POST'],
    '/rest/v1/rpc/publish_safety_section':['POST']
  };
  function blocked(){throw Error('PRODUCTION_TRANSPORT_DENIED');}
  Object.defineProperty(window,'fetch',{configurable:false,writable:false,value:function(input,init){
    var url=new URL(typeof input==='string'||input instanceof URL?input:input.url,window.location.href);
    var method=(init&&init.method||input.method||'GET').toUpperCase();
    if(url.origin!==ORIGIN || url.username || url.password || !routes[url.pathname] || routes[url.pathname].indexOf(method)<0)blocked();
    return transport(input,Object.assign({},init,{redirect:'error',credentials:'omit'}));
  }});
  ['XMLHttpRequest','WebSocket','EventSource','Worker','SharedWorker'].forEach(function(name){
    Object.defineProperty(window,name,{value:blocked,configurable:false,writable:false});
  });
  if(window.navigator){
    Object.defineProperty(window.navigator,'sendBeacon',{value:blocked,configurable:false});
    Object.defineProperty(window.navigator,'serviceWorker',{get:blocked,configurable:false});
  }
  Object.defineProperty(window,'NARJIS_PRODUCTION_TRANSPORT_READY',{value:true,writable:false,configurable:false});
})();
