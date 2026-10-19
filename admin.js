const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const helmet = require('helmet');

// --- DATABASE SETUP (Shared schema definition to avoid OverwriteModelError) ---
let cached = global.mongoose;
if (!cached) { cached = global.mongoose = { conn: null, promise: null }; }
async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'smilecare' }).then(m => m);
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

const ServiceSchema = new mongoose.Schema({ name: String, description: String, price: Number, durationMinutes: Number, icon: String, active: Boolean });
const Service = mongoose.models.Service || mongoose.model('Service', ServiceSchema);

const DentistSchema = new mongoose.Schema({ name: String, specialization: String, experience: String, imageUrl: String, active: Boolean });
const Dentist = mongoose.models.Dentist || mongoose.model('Dentist', DentistSchema);

const AppointmentSchema = new mongoose.Schema({
  bookingReference: String, patientName: String, phone: String, email: String,
  serviceId: mongoose.Schema.Types.ObjectId, serviceName: String,
  dentistId: mongoose.Schema.Types.ObjectId, dentistName: String,
  appointmentDate: String, startTime: String, endTime: String,
  durationMinutes: Number, price: Number, status: String, notes: String
}, { timestamps: true });
const Appointment = mongoose.models.Appointment || mongoose.model('Appointment', AppointmentSchema);

// --- EXPRESS APP & MIDDLEWARE ---
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(cookieParser());

// Connect DB for all admin routes
app.use(async (req, res, next) => {
  try { await connectDB(); next(); } 
  catch (err) { res.status(500).json({ error: "Database error" }); }
});

// Admin Auth Middleware
function requireAuth(req, res, next) {
  const token = req.cookies.admin_token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: "Session expired" });
  }
}

// --- ADMIN API ROUTES ---
app.post('/admin/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || !process.env.JWT_SECRET) {
    return res.status(500).json({ error: "Admin credentials not configured on server" });
  }

  const envUser = Buffer.from(process.env.ADMIN_USERNAME);
  const inputUser = Buffer.from(username || '');
  const envPass = Buffer.from(process.env.ADMIN_PASSWORD);
  const inputPass = Buffer.from(password || '');

  if (envUser.length === inputUser.length && crypto.timingSafeEqual(envUser, inputUser) &&
      envPass.length === inputPass.length && crypto.timingSafeEqual(envPass, inputPass)) {
    
    const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.cookie('admin_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 });
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

app.post('/admin/api/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.json({ success: true });
});

app.get('/admin/api/me', requireAuth, (req, res) => res.json({ loggedIn: true }));

app.get('/admin/api/dashboard', requireAuth, async (req, res) => {
  const total = await Appointment.countDocuments();
  const pending = await Appointment.countDocuments({ status: 'Pending' });
  const confirmed = await Appointment.countDocuments({ status: 'Confirmed' });
  
  // Today's appointments (Karachi timezone)
  const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Karachi"}));
  const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const todayCount = await Appointment.countDocuments({ appointmentDate: todayStr, status: { $nin: ['Cancelled'] } });

  res.json({ total, pending, confirmed, todayCount });
});

app.get('/admin/api/appointments', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const skip = (page - 1) * limit;
  const appointments = await Appointment.find().sort({ createdAt: -1 }).skip(skip).limit(limit);
  res.json(appointments);
});

app.patch('/admin/api/appointments/:id', requireAuth, async (req, res) => {
  const { status } = req.body;
  if (!['Pending', 'Confirmed', 'Completed', 'Cancelled', 'No-show'].includes(status)) return res.status(400).json({ error: "Invalid status" });
  await Appointment.findByIdAndUpdate(req.params.id, { status });
  res.json({ success: true });
});

app.get('/admin/api/services', requireAuth, async (req, res) => res.json(await Service.find()));
app.get('/admin/api/dentists', requireAuth, async (req, res) => res.json(await Dentist.find()));


// --- ADMIN FRONTEND HTML ---
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SmileCare Admin Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    :root {
      --bg: #f8fafc; --sidebar: #ffffff; --text: #1e293b; --text-light: #64748b;
      --primary: #6da2f8; --primary-hover: #558df0;
      --shadow: 4px 4px 12px rgba(0,0,0,0.05), -4px -4px 12px rgba(255,255,255,1);
      --inner: inset 2px 2px 5px rgba(0,0,0,0.03);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Nunito', sans-serif; }
    body { background: var(--bg); color: var(--text); display: flex; height: 100vh; overflow: hidden; }
    
    .hidden { display: none !important; }
    .clay-card { background: #fff; border-radius: 20px; box-shadow: var(--shadow); padding: 20px; margin-bottom: 20px; }
    .clay-input { width: 100%; padding: 12px; border-radius: 12px; border: none; background: var(--bg); box-shadow: var(--inner); outline: none; margin-bottom: 15px; }
    .clay-btn { padding: 10px 20px; border-radius: 12px; border: none; background: #fff; box-shadow: var(--shadow); cursor: pointer; font-weight: bold; transition: all 0.2s; }
    .clay-btn.primary { background: var(--primary); color: white; }
    .clay-btn:active { transform: scale(0.98); box-shadow: var(--inner); }

    /* Login Screen */
    #loginScreen { position: fixed; inset: 0; background: var(--bg); z-index: 1000; display: flex; align-items: center; justify-content: center; }
    .login-box { width: 100%; max-width: 400px; text-align: center; }

    /* Layout */
    .sidebar { width: 250px; background: var(--sidebar); padding: 20px; display: flex; flex-direction: column; box-shadow: 2px 0 10px rgba(0,0,0,0.05); z-index: 10; }
    .logo { display: flex; align-items: center; gap: 10px; font-size: 1.2rem; font-weight: 700; color: var(--primary); margin-bottom: 40px; }
    .nav-item { display: flex; align-items: center; gap: 10px; padding: 12px; border-radius: 12px; color: var(--text-light); text-decoration: none; margin-bottom: 10px; cursor: pointer; transition: all 0.2s; }
    .nav-item:hover, .nav-item.active { background: var(--bg); color: var(--primary); box-shadow: var(--inner); }
    
    .main-content { flex: 1; padding: 30px; overflow-y: auto; }
    .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; }
    
    /* Stats Grid */
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .stat-card { text-align: center; }
    .stat-card h3 { font-size: 2rem; color: var(--primary); }
    .stat-card p { color: var(--text-light); font-size: 0.9rem; }

    /* Table */
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th, td { padding: 12px 15px; border-bottom: 1px solid #f1f5f9; }
    th { color: var(--text-light); font-size: 0.9rem; }
    .status-badge { padding: 4px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: bold; }
    .st-Pending { background: #fef3c7; color: #d97706; }
    .st-Confirmed { background: #d1fae5; color: #059669; }
    .st-Completed { background: #e0f2fe; color: #0284c7; }
    .st-Cancelled { background: #fee2e2; color: #dc2626; }
    
    .action-select { padding: 5px; border-radius: 8px; border: 1px solid #e2e8f0; outline: none; }
  </style>
</head>
<body>

  <!-- Login Screen -->
  <div id="loginScreen">
    <div class="clay-card login-box">
      <i data-lucide="lock" style="width:48px; height:48px; color:var(--primary); margin-bottom:20px;"></i>
      <h2 style="margin-bottom:20px;">Admin Login</h2>
      <form id="loginForm">
        <input type="text" id="username" class="clay-input" placeholder="Username" required>
        <input type="password" id="password" class="clay-input" placeholder="Password" required>
        <p id="loginError" style="color:red; font-size:0.85rem; margin-bottom:10px;"></p>
        <button type="submit" class="clay-btn primary" style="width:100%;">Login</button>
      </form>
    </div>
  </div>

  <!-- Sidebar -->
  <div class="sidebar">
    <div class="logo"><i data-lucide="smile"></i> SmileCare Admin</div>
    <div class="nav-item active" onclick="switchView('dashboard')"><i data-lucide="layout-dashboard"></i> Dashboard</div>
    <div class="nav-item" onclick="switchView('appointments')"><i data-lucide="calendar"></i> Appointments</div>
    <div style="margin-top: auto;">
      <div class="nav-item" onclick="logout()"><i data-lucide="log-out"></i> Logout</div>
    </div>
  </div>

  <!-- Main Content -->
  <div class="main-content">
    <div class="topbar">
      <h2 id="pageTitle">Overview</h2>
      <div>Asia/Karachi Timezone</div>
    </div>

    <!-- Dashboard View -->
    <div id="view-dashboard">
      <div class="stats-grid">
        <div class="clay-card stat-card"><h3 id="st-today">0</h3><p>Appointments Today</p></div>
        <div class="clay-card stat-card"><h3 id="st-pending">0</h3><p>Pending</p></div>
        <div class="clay-card stat-card"><h3 id="st-confirmed">0</h3><p>Confirmed</p></div>
        <div class="clay-card stat-card"><h3 id="st-total">0</h3><p>Total All Time</p></div>
      </div>
      <div class="clay-card">
        <h3>Recent Appointments</h3>
        <p style="color:var(--text-light); font-size:0.9rem; margin-bottom: 15px;">Switch to Appointments tab to manage status.</p>
      </div>
    </div>

    <!-- Appointments View -->
    <div id="view-appointments" class="hidden">
      <div class="clay-card" style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Ref</th><th>Patient</th><th>Service</th><th>Dentist</th><th>Date & Time</th><th>Status</th><th>Action</th>
            </tr>
          </thead>
          <tbody id="appTableBody">
            <tr><td colspan="7" style="text-align:center;">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    lucide.createIcons();

    // Check Auth on load
    fetch('/admin/api/me').then(r => r.json()).then(data => {
      if(data.loggedIn) { document.getElementById('loginScreen').classList.add('hidden'); loadDashboard(); }
    }).catch(e => console.log("Not logged in"));

    // Login logic
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = document.getElementById('username').value;
      const p = document.getElementById('password').value;
      const res = await fetch('/admin/api/login', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username: u, password: p})
      });
      const data = await res.json();
      if(data.success) {
        document.getElementById('loginScreen').classList.add('hidden');
        loadDashboard();
      } else {
        document.getElementById('loginError').textContent = data.error || "Login failed";
      }
    });

    async function logout() {
      await fetch('/admin/api/logout', { method: 'POST' });
      window.location.reload();
    }

    function switchView(view) {
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      event.currentTarget.classList.add('active');
      document.getElementById('view-dashboard').classList.add('hidden');
      document.getElementById('view-appointments').classList.add('hidden');
      document.getElementById('view-' + view).classList.remove('hidden');
      document.getElementById('pageTitle').textContent = view.charAt(0).toUpperCase() + view.slice(1);
      
      if(view === 'dashboard') loadDashboard();
      if(view === 'appointments') loadAppointments();
    }

    async function loadDashboard() {
      const res = await fetch('/admin/api/dashboard');
      const data = await res.json();
      document.getElementById('st-today').textContent = data.todayCount;
      document.getElementById('st-pending').textContent = data.pending;
      document.getElementById('st-confirmed').textContent = data.confirmed;
      document.getElementById('st-total').textContent = data.total;
    }

    async function loadAppointments() {
      const res = await fetch('/admin/api/appointments');
      const data = await res.json();
      const tbody = document.getElementById('appTableBody');
      tbody.innerHTML = data.map(a => \`
        <tr>
          <td style="font-family:monospace; font-weight:bold;">\${a.bookingReference}</td>
          <td>\${a.patientName}<br><small style="color:var(--text-light)">\${a.phone}</small></td>
          <td>\${a.serviceName}</td>
          <td>\${a.dentistName}</td>
          <td>\${a.appointmentDate}<br><small>\${a.startTime}</small></td>
          <td><span class="status-badge st-\${a.status.replace('-','')}">\${a.status}</span></td>
          <td>
            <select class="action-select" onchange="updateStatus('\${a._id}', this.value)">
              <option value="" disabled selected>Change...</option>
              <option value="Confirmed">Confirm</option>
              <option value="Completed">Complete</option>
              <option value="Cancelled">Cancel</option>
              <option value="No-show">No-show</option>
            </select>
          </td>
        </tr>
      \`).join('');
    }

    async function updateStatus(id, status) {
      if(!confirm("Change status to " + status + "?")) { loadAppointments(); return; }
      await fetch('/admin/api/appointments/' + id, {
        method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({status})
      });
      loadAppointments();
      loadDashboard();
    }
  </script>
</body>
</html>`;

app.get('/admin', (req, res) => res.send(ADMIN_HTML));

module.exports = app;
