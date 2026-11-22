import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";
const SERVICES = ["tyre", "battery", "fuel", "engine", "towing"];
const VEHICLES = ["Car", "Bike", "Auto", "Truck"];
const emptyLocation = { lat: 16.5062, lng: 80.6480 };

async function request(path, token, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
function useLocation() {
  const [location, setLocation] = useState(emptyLocation);
  useEffect(() => {
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(
      p => setLocation({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {}, { enableHighAccuracy: true, timeout: 6000 }
    );
  }, []);
  return location;
}
function App() {
  const [session, setSession] = useState(() => {
    try { return JSON.parse(localStorage.getItem("roadaid-session")) || null; } catch { return null; }
  });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const location = useLocation();
  useEffect(() => {
    if (!session?.token) return;
    const socket = io(API);
    socket.on("connect", () => socket.emit("authenticate", session.token));
    socket.on("notification", n => setNotice(n.message || "RoadAid update received"));
    socket.on("refresh", () => window.dispatchEvent(new Event("roadaid-refresh")));
    return () => socket.disconnect();
  }, [session]);
  function saveSession(value) {
    localStorage.setItem("roadaid-session", JSON.stringify(value));
    setSession(value); setNotice(`Welcome to RoadAid, ${value.user.name}!`);
  }
  function logout() { localStorage.removeItem("roadaid-session"); setSession(null); setNotice("You have logged out."); }
  async function handleAuth(path, body) {
    setBusy(true);
    try { saveSession(await request(path, null, { method: "POST", body: JSON.stringify({ ...body, ...location }) })); }
    catch (e) { setNotice(e.message); }
    finally { setBusy(false); }
  }
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="#"><span className="brand-icon">✦</span> RoadAid</a>
      <span className="tagline">Help is closer than you think.</span>
      {session && <button className="button ghost small" onClick={logout}>Log out</button>}
    </header>
    {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}
    {!session ? <Auth onAuth={handleAuth} busy={busy} /> :
      <main className="main"><div className="welcome"><div><p className="eyebrow">ROADAID ASSISTANCE NETWORK</p><h1>Hello, {session.user.name}</h1><p>Signed in as <b>{session.user.role}</b></p></div><span className="role-pill">{session.user.role}</span></div>
        {session.user.role === "driver" && <Driver token={session.token} location={location} flash={setNotice} />}
        {session.user.role === "mechanic" && <Mechanic token={session.token} location={location} flash={setNotice} />}
        {session.user.role === "admin" && <Admin token={session.token} flash={setNotice} />}
      </main>}
    <footer>RoadAid · On-road vehicle breakdown assistance</footer>
  </div>;
}
function Auth({ onAuth, busy }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ name:"", phone:"", email:"", password:"", role:"driver", services:[] });
  const update = (key, value) => setForm(f => ({ ...f, [key]: value }));
  const toggle = s => update("services", form.services.includes(s) ? form.services.filter(x => x !== s) : [...form.services, s]);
  return <main className="auth-layout"><section className="hero"><p className="eyebrow">ROADSIDE HELP, REIMAGINED</p><h1>Breakdowns happen.<br/><em>Being stranded</em> doesn't.</h1><p>Connect with nearby mechanics, send an SOS and keep track of your roadside assistance request.</p><div className="hero-stats"><span><b>01</b> Report a problem</span><span><b>02</b> Find nearby help</span><span><b>03</b> Get moving again</span></div></section>
    <section className="auth-card"><div className="tabs"><button className={mode==="login"?"active":""} onClick={() => setMode("login")}>Log in</button><button className={mode==="register"?"active":""} onClick={() => setMode("register")}>Create account</button></div>
      <h2>{mode==="login"?"Welcome back":"Join RoadAid"}</h2><p className="muted">{mode==="login"?"Enter your details to continue.":"Create a driver or mechanic account."}</p>
      <form onSubmit={e => { e.preventDefault(); onAuth(mode==="login"?"/api/login":"/api/register", form); }}>
        {mode==="register" && <><label>Full name<input required value={form.name} onChange={e=>update("name",e.target.value)} placeholder="Your name"/></label>
        <label>Phone number<input required pattern="[0-9]{10}" value={form.phone} onChange={e=>update("phone",e.target.value)} placeholder="10-digit mobile number"/></label>
        <label>Account type<select value={form.role} onChange={e=>update("role",e.target.value)}><option value="driver">Driver</option><option value="mechanic">Mechanic</option></select></label>
        {form.role==="mechanic" && <div className="field"><span className="field-label">Services offered</span><div className="chips">{SERVICES.map(s=><button type="button" key={s} className={form.services.includes(s)?"chip selected":"chip"} onClick={()=>toggle(s)}>{s}</button>)}</div></div>}</>}
        <label>Email address<input type="email" required value={form.email} onChange={e=>update("email",e.target.value)} placeholder="you@example.com"/></label>
        <label>Password<input type="password" required minLength="8" value={form.password} onChange={e=>update("password",e.target.value)} placeholder="At least 8 characters"/></label>
        <button className="button primary full" disabled={busy}>{busy?"Please wait…":mode==="login"?"Log in →":"Create account →"}</button>
      </form><p className="fine-print">Location permission helps match you with nearby assistance.</p>
    </section></main>;
}
function Panel({ title, subtitle, children, action }) { return <section className="panel"><div className="panel-head"><div><h2>{title}</h2>{subtitle&&<p className="muted">{subtitle}</p>}</div>{action}</div>{children}</section>; }
function MapBox({ location, markers=[] }) {
  return <div className="map-wrap"><MapContainer center={[location.lat,location.lng]} zoom={12} scrollWheelZoom={false} style={{height:"270px",width:"100%"}}>
    <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>
    <Marker position={[location.lat,location.lng]}><Popup>Your location (approximate)</Popup></Marker>
    {markers.map(m=><Marker key={m.id} position={[Number(m.lat),Number(m.lng)]}><Popup>{m.name || m.driver_name || "RoadAid location"}</Popup></Marker>)}
  </MapContainer></div>;
}
function Driver({ token, location, flash }) {
  const [vehicle,setVehicle]=useState("Bike"), [issue,setIssue]=useState("tyre"), [notes,setNotes]=useState("");
  const [mechanics,setMechanics]=useState([]), [jobs,setJobs]=useState([]), [tab,setTab]=useState("request"), [loading,setLoading]=useState(false);
  async function load() { try { const [j,m]=await Promise.all([request("/api/requests/mine",token),request(`/api/mechanics?lat=${location.lat}&lng=${location.lng}&service=${issue}`,token)]); setJobs(j);setMechanics(m); } catch(e){flash(e.message);} }
  useEffect(()=>{load();const f=()=>load();window.addEventListener("roadaid-refresh",f);return()=>window.removeEventListener("roadaid-refresh",f);},[token,location.lat,location.lng,issue]);
  async function create(sos=false) {
    setLoading(true);try { const result=await request("/api/requests",token,{method:"POST",body:JSON.stringify({vehicle,issue:sos?"emergency":issue,notes, ...location})});flash(sos?"SOS sent to available mechanics.":"Your help request has been sent.");setTab("history");await load(); }catch(e){flash(e.message);}finally{setLoading(false);}
  }
  async function rate(id,rating){try{await request(`/api/requests/${id}/rate`,token,{method:"PATCH",body:JSON.stringify({rating})});flash("Thank you for rating the service.");load();}catch(e){flash(e.message);}}
  return <><div className="tab-row">{["request","mechanics","history"].map(t=><button className={tab===t?"tab active":"tab"} onClick={()=>setTab(t)} key={t}>{t==="request"?"Get help":t==="mechanics"?"Nearby mechanics":"My requests"}</button>)}</div>
    {tab==="request"&&<div className="two-col"><Panel title="What happened?" subtitle="Tell us what kind of roadside help you need.">
      <label>Vehicle type<select value={vehicle} onChange={e=>setVehicle(e.target.value)}>{VEHICLES.map(v=><option key={v}>{v}</option>)}</select></label>
      <div className="field"><span className="field-label">Problem type</span><div className="chips">{SERVICES.map(s=><button key={s} className={issue===s?"chip selected":"chip"} onClick={()=>setIssue(s)}>{s}</button>)}</div></div>
      <label>Additional details<textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Describe the problem (optional)" rows="3"/></label>
      <button className="button primary full" disabled={loading} onClick={()=>create(false)}>{loading?"Sending…":"Request roadside help →"}</button>
      <button className="button sos full" disabled={loading} onClick={()=>create(true)}>⚠ Send SOS emergency alert</button>
    </Panel><Panel title="Your location" subtitle="Used to find assistance near you."><MapBox location={location}/><p className="muted coordinates">{location.lat.toFixed(4)}, {location.lng.toFixed(4)}</p></Panel></div>}
    {tab==="mechanics"&&<Panel title="Nearby mechanics" subtitle="Available mechanics within 20 km."><MapBox location={location} markers={mechanics}/>{mechanics.length===0?<p className="empty">No available mechanics found nearby. Try again later.</p>:<div className="cards">{mechanics.map(m=><article className="data-card" key={m.id}><h3>{m.name}</h3><p>{m.services||"Roadside assistance"}</p><b>{Number(m.distance_km).toFixed(1)} km away</b><p>Rating: {m.rating??"New"}</p><a href={`tel:${m.phone}`}>Call mechanic</a></article>)}</div>}</Panel>}
    {tab==="history"&&<Panel title="Your requests" subtitle="Track the progress of your assistance."><div className="cards">{jobs.map(j=><article className="data-card" key={j.id}><div className="card-line"><b>Request #{j.id}</b><span className={`status ${j.status}`}>{j.status}</span></div><p>{j.vehicle} · {j.issue}</p><p>{j.mechanic_name?`Mechanic: ${j.mechanic_name}`:"Waiting for a mechanic"}</p>{j.fare&&<b>Estimated fare: ₹{j.fare}</b>}{j.status==="completed"&&!j.rating&&<div className="rating">Rate service: {[1,2,3,4,5].map(n=><button key={n} onClick={()=>rate(j.id,n)}>{n}★</button>)}</div>}</article>)}</div>{jobs.length===0&&<p className="empty">Your requests will appear here.</p>}</Panel>)}
  </>;
}
function Mechanic({token,location,flash}) {
  const [available,setAvailable]=useState(true),[nearby,setNearby]=useState([]),[jobs,setJobs]=useState([]);
  async function load(){try{const [a,b]=await Promise.all([request(`/api/requests/nearby?lat=${location.lat}&lng=${location.lng}`,token),request("/api/requests/jobs",token)]);setNearby(a);setJobs(b);}catch(e){flash(e.message);}}
  useEffect(()=>{load();const f=()=>load();window.addEventListener("roadaid-refresh",f);return()=>window.removeEventListener("roadaid-refresh",f);},[token,location.lat,location.lng]);
  async function toggle(){try{await request("/api/mechanic/status",token,{method:"PATCH",body:JSON.stringify({available:!available})});setAvailable(!available);flash("Availability updated.");}catch(e){flash(e.message);}}
  async function act(id,action){try{await request(`/api/requests/${id}/${action}`,token,{method:"PATCH",body:"{}"});flash(action==="accept"?"Request accepted.":"Job marked completed.");load();}catch(e){flash(e.message);}}
  const completed=jobs.filter(j=>j.status==="completed");
  return <><div className="metric-grid"><div className="metric"><span>Availability</span><b>{available?"Available":"Offline"}</b><button className="button small" onClick={toggle}>Go {available?"offline":"online"}</button></div><div className="metric"><span>Completed jobs</span><b>{completed.length}</b></div><div className="metric"><span>Total earnings</span><b>₹{completed.reduce((s,j)=>s+Number(j.fare||0),0)}</b></div></div>
    <div className="two-col"><Panel title="Open requests near you" subtitle="SOS requests are prioritised."><MapBox location={location} markers={nearby.map(r=>({...r,name:r.driver_name}))}/>{nearby.map(r=><article className="data-card" key={r.id}><div className="card-line"><b>#{r.id} · {r.vehicle}</b><span className={`status ${r.issue==="emergency"?"emergency":r.status}`}>{r.issue==="emergency"?"SOS":r.issue}</span></div><p>{r.driver_name} · {Number(r.distance_km).toFixed(1)} km away</p><p>{r.notes||"No additional details"}</p><button className="button primary small" onClick={()=>act(r.id,"accept")}>Accept job</button></article>)}{nearby.length===0&&<p className="empty">No open requests in your area.</p>}</Panel>
    <Panel title="My jobs" subtitle="Accepted and completed work.">{jobs.map(j=><article className="data-card" key={j.id}><div className="card-line"><b>#{j.id} · {j.vehicle}</b><span className={`status ${j.status}`}>{j.status}</span></div><p>{j.issue} · Driver: {j.driver_name}</p>{j.fare&&<p>Fare: ₹{j.fare}</p>}{j.status==="accepted"&&<button className="button primary small" onClick={()=>act(j.id,"complete")}>Mark completed</button>}</article>)}</Panel></div></>;
}
function Admin({token,flash}) {
  const [stats,setStats]=useState({}),[users,setUsers]=useState([]),[jobs,setJobs]=useState([]);
  async function load(){try{const [s,u,j]=await Promise.all([request("/api/admin/stats",token),request("/api/admin/users",token),request("/api/admin/requests",token)]);setStats(s);setUsers(u);setJobs(j);}catch(e){flash(e.message);}}
  useEffect(()=>{load();const f=()=>load();window.addEventListener("roadaid-refresh",f);return()=>window.removeEventListener("roadaid-refresh",f);},[token]);
  async function remove(id){if(!confirm("Remove this user?"))return;try{await request(`/api/admin/users/${id}`,token,{method:"DELETE"});flash("User removed.");load();}catch(e){flash(e.message);}}
  const metrics=[["Total users",stats.totalUsers],["Drivers",stats.drivers],["Mechanics",stats.mechanics],["Open requests",stats.openRequests],["Completed",stats.completed],["Revenue",`₹${stats.revenue||0}`]];
  return <><div className="metric-grid">{metrics.map(([k,v])=><div className="metric" key={k}><span>{k}</span><b>{v??0}</b></div>)}</div>
    <div className="two-col"><Panel title="User management"><div className="table-scroll"><table><thead><tr><th>Name</th><th>Role</th><th>Email</th><th></th></tr></thead><tbody>{users.map(u=><tr key={u.id}><td>{u.name}</td><td>{u.role}</td><td>{u.email}</td><td>{u.role!=="admin"&&<button className="link-danger" onClick={()=>remove(u.id)}>Remove</button>}</td></tr>)}</tbody></table></div></Panel>
    <Panel title="Recent requests"><div className="table-scroll"><table><thead><tr><th>ID</th><th>Driver</th><th>Issue</th><th>Status</th></tr></thead><tbody>{jobs.map(j=><tr key={j.id}><td>#{j.id}</td><td>{j.driver_name}</td><td>{j.issue}</td><td>{j.status}</td></tr>)}</tbody></table></div></Panel></div></>;
}
export default App;
