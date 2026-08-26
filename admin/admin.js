const API='/api';
const adminKey=()=>localStorage.getItem('testyAdminKey')||'';
window.adminFetch=async(url,options={})=>fetch(url,{...options,headers:{...(options.headers||{}),'X-Admin-Key':adminKey(),'Content-Type':'application/json'}});
function showToast(message){const t=document.getElementById('toast');if(t){t.textContent=message;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500)}else alert(message)}
const form=document.getElementById('adminLoginForm');
if(form)form.addEventListener('submit',async e=>{e.preventDefault();const email=document.getElementById('adminEmail').value.trim(),password=document.getElementById('adminPassword').value.trim(),button=document.getElementById('adminLoginBtn');button.disabled=true;button.textContent='Signing In...';try{const r=await fetch(`${API}/admin/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:password})});if(!r.ok)throw Error();const d=await r.json();localStorage.setItem('testyAdminKey',d.admin_key);localStorage.setItem('userRole','admin');localStorage.setItem('adminEmail',email);location.href='dashboard.html'}catch(err){button.disabled=false;button.textContent='Login to Dashboard';showToast('Invalid admin credentials.')}});
const toggle=document.getElementById('toggleAdminPassword');if(toggle)toggle.onclick=()=>{const p=document.getElementById('adminPassword');p.type=p.type==='password'?'text':'password'};
if(!location.pathname.endsWith('login.html')&&!adminKey())location.href='login.html';
function logout(){localStorage.removeItem('testyAdminKey');localStorage.removeItem('userRole');localStorage.removeItem('adminEmail');location.href='login.html'}
