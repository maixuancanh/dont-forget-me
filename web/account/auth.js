(async () => {
// Same-origin deployment required. Browser credentials stay in HttpOnly cookies.
let csrfToken="";
const status=document.querySelector("#status");
const incoming=new URLSearchParams(location.hash.slice(1)).get("challenge");
if(incoming&&/^[a-f0-9]{64}$/.test(incoming))sessionStorage.setItem("dfm_desktop_challenge",incoming);
const challenge=sessionStorage.getItem("dfm_desktop_challenge");
if(challenge&&/^[a-f0-9]{64}$/.test(challenge))document.querySelector("#desktop").hidden=false;
history.replaceState(null,"",location.pathname);
async function request(path,body){const response=await fetch("/v1/auth/"+path,{method:body?"POST":"GET",credentials:"same-origin",headers:body?{"Content-Type":"application/json","X-CSRF-Token":csrfToken}:{},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok)throw new Error(data.error||"Account unavailable");return data;}
async function refresh(){try{const data=await request("me");csrfToken=data.csrfToken||"";status.textContent=`Signed in as ${data.user.name}`;}catch{status.textContent="Sign in to resume your saved game.";}}
function action(id,fn){document.querySelector(id).onclick=async()=>{try{await fn();}catch(error){status.textContent=error.message;}};}
action("#login",async()=>{const data=await request("login");location.assign(data.authorizationUrl);});
action("#link",async()=>{const data=await request("link",{});location.assign(data.authorizationUrl);});
action("#logout",async()=>{await request("logout",{});csrfToken="";document.querySelector("#code").textContent="";await refresh();});
action("#handoff",async()=>{const data=await request("handoff",{challenge});document.querySelector("#code").textContent=data.code;setTimeout(()=>{document.querySelector("#code").textContent="Expired. Create a new code.";},60000);});
await refresh();

})().catch(error => { const output = document.querySelector('#status'); if (output) output.textContent = error.message; });
