const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

// --- DATABASE SETUP (Shared serverless connection) ---
let cached = global.mongoose;
if (!cached) { cached = global.mongoose = { conn: null, promise: null }; }

async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is missing");
    cached.promise = mongoose.connect(uri, {
      dbName: process.env.MONGODB_DB || 'smilecare'
    }).then(mongoose => mongoose);
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// --- MONGOOSE MODELS ---
const ServiceSchema = new mongoose.Schema({
  name: String, description: String, price: Number, durationMinutes: Number, icon: String, active: { type: Boolean, default: true }
});
const Service = mongoose.models.Service || mongoose.model('Service', ServiceSchema);

const DentistSchema = new mongoose.Schema({
  name: String, specialization: String, experience: String, imageUrl: String, active: { type: Boolean, default: true }
});
const Dentist = mongoose.models.Dentist || mongoose.model('Dentist', DentistSchema);

const AppointmentSchema = new mongoose.Schema({
  bookingReference: { type: String, unique: true },
  patientName: String, phone: String, email: String,
  serviceId: mongoose.Schema.Types.ObjectId, serviceName: String,
  dentistId: mongoose.Schema.Types.ObjectId, dentistName: String,
  appointmentDate: String, // YYYY-MM-DD
  startTime: String, // HH:mm
  endTime: String, // HH:mm
  durationMinutes: Number, price: Number,
  status: { type: String, enum: ['Pending', 'Confirmed', 'Completed', 'Cancelled', 'No-show'], default: 'Pending' },
  notes: String
}, { timestamps: true });

// Prevent double bookings natively with a partial unique index
AppointmentSchema.index(
  { dentistId: 1, appointmentDate: 1, startTime: 1 },
  { unique: true, partialFilterExpression: { status: { $nin: ['Cancelled', 'No-show'] } } }
);
const Appointment = mongoose.models.Appointment || mongoose.model('Appointment', AppointmentSchema);

// --- SEED DEMO DATA ---
async function seedData() {
  const serviceCount = await Service.countDocuments();
  if (serviceCount === 0) {
    await Service.insertMany([
      { name: "General Checkup", description: "Comprehensive dental exam and consultation.", price: 1500, durationMinutes: 30, icon: "stethoscope" },
      { name: "Cleaning & Scaling", description: "Professional plaque and tartar removal.", price: 2500, durationMinutes: 45, icon: "sparkles" },
      { name: "Teeth Whitening", description: "Advanced laser whitening for a brighter smile.", price: 8000, durationMinutes: 60, icon: "sun" },
      { name: "Braces Consultation", description: "Orthodontic evaluation and treatment planning.", price: 2000, durationMinutes: 30, icon: "smile" },
      { name: "Root Canal", description: "Pain-free root canal treatment.", price: 12000, durationMinutes: 60, icon: "activity" },
      { name: "Pediatric Care", description: "Gentle dental care for children.", price: 2000, durationMinutes: 30, icon: "heart" }
    ]);
  }
  const dentistCount = await Dentist.countDocuments();
  if (dentistCount === 0) {
    await Dentist.insertMany([
      { name: "Dr. Ayesha Khan", specialization: "General & Cosmetic Dentist", experience: "12 Years", imageUrl: "https://images.unsplash.com/photo-1559839734-2b71ea197ec2?w=400&q=80" },
      { name: "Dr. Hamza Ahmed", specialization: "Orthodontist", experience: "8 Years", imageUrl: "https://images.unsplash.com/photo-1622253692010-333f2da6031d?w=400&q=80" },
      { name: "Dr. Sara Malik", specialization: "Pediatric Dentist", experience: "10 Years", imageUrl: "https://images.unsplash.com/photo-1594824432258-0062dfc91fb1?w=400&q=80" }
    ]);
  }
}

// --- EXPRESS APP SETUP ---
const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // Disabled CSP for demo inline scripts/styles
app.use(express.json({ limit: '10kb' }));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

// Make sure DB is connected and seeded before API runs
app.use('/api', async (req, res, next) => {
  try {
    await connectDB();
    await seedData();
    next();
  } catch (err) {
    res.status(500).json({ error: "Database connection failed" });
  }
});

// --- API ROUTES ---
app.get('/api/health', (req, res) => res.json({ status: 'ok', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));

app.get('/api/services', async (req, res) => {
  const services = await Service.find({ active: true }).select('-__v');
  res.json(services);
});

app.get('/api/dentists', async (req, res) => {
  const dentists = await Dentist.find({ active: true }).select('-__v');
  res.json(dentists);
});

app.get('/api/availability', async (req, res) => {
  const { date, dentistId, serviceId } = req.query;
  if (!date || !dentistId || !serviceId) return res.status(400).json({ error: "Missing parameters" });

  try {
    const service = await Service.findById(serviceId);
    if (!service) return res.status(404).json({ error: "Service not found" });

    // Clinic hours: 09:00 to 20:00. Timezone Asia/Karachi
    const startHour = 9; const endHour = 20;
    const interval = 30; // 30 min intervals
    let availableSlots = [];
    
    // Generate all slots
    for(let h = startHour; h < endHour; h++) {
      for(let m = 0; m < 60; m += interval) {
        const hh = h.toString().padStart(2, '0');
        const mm = m.toString().padStart(2, '0');
        availableSlots.push(`${hh}:${mm}`);
      }
    }

    // Filter past times if date is today in Karachi
    const nowKHI = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Karachi" }));
    const todayStr = `${nowKHI.getFullYear()}-${String(nowKHI.getMonth()+1).padStart(2,'0')}-${String(nowKHI.getDate()).padStart(2,'0')}`;
    if (date === todayStr) {
      const currentMinutes = nowKHI.getHours() * 60 + nowKHI.getMinutes();
      availableSlots = availableSlots.filter(time => {
        const [th, tm] = time.split(':').map(Number);
        return (th * 60 + tm) > currentMinutes + 60; // 1 hour buffer
      });
    }

    // Fetch existing appointments
    const existing = await Appointment.find({
      dentistId, appointmentDate: date, status: { $nin: ['Cancelled', 'No-show'] }
    });

    // Remove overlapping slots
    const serviceDuration = service.durationMinutes;
    availableSlots = availableSlots.filter(slot => {
      const slotStart = parseTime(slot);
      const slotEnd = slotStart + serviceDuration;
      
      // Prevent booking past closing time
      if (slotEnd > endHour * 60) return false;

      // Check overlaps
      for (const appt of existing) {
        const apptStart = parseTime(appt.startTime);
        const apptEnd = parseTime(appt.endTime);
        if (slotStart < apptEnd && slotEnd > apptStart) return false;
      }
      return true;
    });

    res.json({ date, slots: availableSlots });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post('/api/appointments', async (req, res) => {
  try {
    const { patientName, phone, email, serviceId, dentistId, appointmentDate, startTime, notes } = req.body;
    if (!patientName || !phone || !serviceId || !dentistId || !appointmentDate || !startTime) {
      return res.status(400).json({ error: "Please fill all required fields." });
    }

    const service = await Service.findById(serviceId);
    const dentist = await Dentist.findById(dentistId);
    if (!service || !dentist) return res.status(400).json({ error: "Invalid service or dentist." });

    const startMins = parseTime(startTime);
    const endMins = startMins + service.durationMinutes;
    const endTime = `${String(Math.floor(endMins/60)).padStart(2,'0')}:${String(endMins%60).padStart(2,'0')}`;

    const bookingReference = crypto.randomBytes(4).toString('hex').toUpperCase();

    const appt = new Appointment({
      bookingReference, patientName, phone, email,
      serviceId, serviceName: service.name,
      dentistId, dentistName: dentist.name,
      appointmentDate, startTime, endTime,
      durationMinutes: service.durationMinutes, price: service.price,
      notes
    });

    await appt.save(); // Unique index prevents double booking
    res.json({ success: true, appointment: appt });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "This slot was just booked by someone else. Please choose another time." });
    res.status(500).json({ error: "Failed to create appointment." });
  }
});

function parseTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// --- FRONTEND APPLICATION (HTML/CSS/JS) ---
const PUBLIC_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SmileCare Dental Clinic | Your Smile, Our Passion</title>
  <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    :root {
      --bg: #f2f7f9; --text: #1e293b; --text-light: #64748b;
      --primary: #6da2f8; --primary-hover: #558df0; --accent: #ffb8b8;
      --card-bg: #ffffff;
      --shadow-outer: 8px 8px 20px rgba(175, 190, 205, 0.4), -8px -8px 20px rgba(255, 255, 255, 1);
      --shadow-inner: inset 4px 4px 8px rgba(175, 190, 205, 0.2), inset -4px -4px 8px rgba(255, 255, 255, 0.9);
      --shadow-pressed: inset 6px 6px 12px rgba(175, 190, 205, 0.4), inset -6px -6px 12px rgba(255, 255, 255, 1);
      --radius: 28px; --radius-sm: 16px;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Nunito', sans-serif; }
    body { background-color: var(--bg); color: var(--text); overflow-x: hidden; line-height: 1.6; }
    
    /* Typography & Utilities */
    h1, h2, h3 { font-weight: 800; color: #101828; }
    .text-center { text-align: center; }
    .section-title { font-size: 2.5rem; margin-bottom: 1rem; color: #1e293b; }
    .section-subtitle { font-size: 1.1rem; color: var(--text-light); max-width: 600px; margin: 0 auto 3rem auto; }
    .container { max-width: 1200px; margin: 0 auto; padding: 0 20px; }
    .py-20 { padding-top: 5rem; padding-bottom: 5rem; }
    .hidden { display: none !important; }
    
    /* Claymorphism UI Components */
    .clay-card {
      background: var(--card-bg); border-radius: var(--radius);
      box-shadow: var(--shadow-outer); padding: 2rem;
      border: 1px solid rgba(255, 255, 255, 0.6);
      transition: transform 0.3s ease, box-shadow 0.3s ease;
    }
    .clay-card:hover { transform: translateY(-5px); box-shadow: 12px 12px 24px rgba(175, 190, 205, 0.5), -12px -12px 24px rgba(255, 255, 255, 1); }
    
    .clay-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      background: var(--bg); color: var(--primary); font-weight: 700; font-size: 1rem;
      padding: 12px 28px; border-radius: 50px; border: none; cursor: pointer;
      box-shadow: var(--shadow-outer); transition: all 0.2s ease; text-decoration: none;
    }
    .clay-btn.primary { background: var(--primary); color: white; box-shadow: 6px 6px 16px rgba(109, 162, 248, 0.4), -6px -6px 16px rgba(255, 255, 255, 0.8); }
    .clay-btn:active { box-shadow: var(--shadow-pressed); transform: scale(0.98); }
    .clay-btn.primary:active { box-shadow: inset 4px 4px 10px rgba(0,0,0,0.1), inset -4px -4px 10px rgba(255,255,255,0.3); }

    .clay-input {
      width: 100%; padding: 14px 20px; border-radius: var(--radius-sm); border: none;
      background: var(--bg); box-shadow: var(--shadow-pressed);
      font-size: 1rem; outline: none; color: var(--text); margin-bottom: 1rem;
    }
    .clay-input:focus { box-shadow: var(--shadow-inner), 0 0 0 3px rgba(109, 162, 248, 0.3); }

    /* Header */
    header { position: sticky; top: 0; z-index: 100; background: rgba(242, 247, 249, 0.9); backdrop-filter: blur(10px); padding: 1rem 0; box-shadow: 0 4px 20px rgba(0,0,0,0.03); }
    .header-content { display: flex; justify-content: space-between; align-items: center; }
    .logo { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 1.5rem; color: var(--primary); text-decoration: none; }
    .nav-links { display: flex; gap: 2rem; align-items: center; }
    .nav-links a { text-decoration: none; color: var(--text); font-weight: 600; transition: color 0.3s; }
    .nav-links a:hover { color: var(--primary); }
    .mobile-menu-btn { display: none; background: none; border: none; cursor: pointer; color: var(--text); }

    /* Hero */
    .hero { display: grid; grid-template-columns: 1fr 1fr; gap: 4rem; align-items: center; min-height: 85vh; }
    .hero h1 { font-size: 4rem; line-height: 1.1; margin-bottom: 1.5rem; }
    .hero p { font-size: 1.2rem; margin-bottom: 2rem; color: var(--text-light); }
    .hero-buttons { display: flex; gap: 1rem; margin-bottom: 3rem; }
    .trust-stats { display: flex; gap: 2rem; }
    .stat-item { background: var(--bg); padding: 1rem 1.5rem; border-radius: var(--radius-sm); box-shadow: var(--shadow-outer); text-align: center; }
    .stat-item strong { display: block; font-size: 1.5rem; color: var(--primary); }
    .stat-item span { font-size: 0.85rem; color: var(--text-light); }
    .hero-image { position: relative; }
    .hero-image img { width: 100%; border-radius: 40px; box-shadow: var(--shadow-outer); }
    
    /* Grids */
    .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 2rem; }
    .grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 2rem; }
    
    /* Service Cards */
    .service-card { text-align: center; }
    .service-icon { width: 64px; height: 64px; margin: 0 auto 1.5rem; border-radius: 50%; background: var(--bg); box-shadow: var(--shadow-outer); display: flex; align-items: center; justify-content: center; color: var(--primary); }
    .service-card h3 { margin-bottom: 0.5rem; }
    .service-price { font-weight: 700; color: var(--primary); margin: 1rem 0; font-size: 1.25rem; }
    
    /* Dentist Cards */
    .dentist-card img { width: 120px; height: 120px; border-radius: 50%; object-fit: cover; margin: 0 auto 1rem; box-shadow: var(--shadow-inner); display: block; padding: 5px; background: var(--bg); }
    
    /* Booking Modal Overlay */
    .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(5px); z-index: 1000; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity 0.3s; padding: 20px; }
    .modal-overlay.active { opacity: 1; pointer-events: auto; }
    .booking-modal { width: 100%; max-width: 700px; max-height: 90vh; overflow-y: auto; position: relative; }
    .close-modal { position: absolute; top: 20px; right: 20px; background: var(--bg); border: none; width: 40px; height: 40px; border-radius: 50%; box-shadow: var(--shadow-outer); cursor: pointer; display: flex; align-items: center; justify-content: center; }
    
    .wizard-step { display: none; animation: fadeIn 0.4s ease; }
    .wizard-step.active { display: block; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    
    /* Slots grid */
    .slots-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 10px; margin-top: 15px; }
    .slot-btn { padding: 10px; border-radius: 12px; background: var(--bg); border: none; box-shadow: var(--shadow-outer); cursor: pointer; font-weight: 600; color: var(--text); transition: all 0.2s; }
    .slot-btn:hover { color: var(--primary); }
    .slot-btn.selected { background: var(--primary); color: white; box-shadow: inset 2px 2px 5px rgba(0,0,0,0.2); }
    
    /* Selectable Cards */
    .selectable-card { cursor: pointer; text-align: left; padding: 1rem; border: 2px solid transparent; }
    .selectable-card:hover { border-color: var(--primary); }
    .selectable-card.selected { border-color: var(--primary); background: rgba(109, 162, 248, 0.05); box-shadow: var(--shadow-inner); }

    /* Footer & FAQ */
    .faq-item { margin-bottom: 1rem; }
    .faq-q { width: 100%; text-align: left; padding: 1.5rem; font-size: 1.1rem; font-weight: 700; background: var(--bg); border: none; border-radius: var(--radius-sm); box-shadow: var(--shadow-outer); cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
    .faq-a { padding: 0 1.5rem; max-height: 0; overflow: hidden; transition: max-height 0.3s ease; }
    .faq-item.open .faq-a { max-height: 200px; padding: 1rem 1.5rem; }
    
    footer { background: #ffffff; padding: 4rem 0 2rem; margin-top: 4rem; text-align: center; border-top: 1px solid rgba(0,0,0,0.05); }
    
    /* Animations & Utils */
    .reveal { opacity: 0; transform: translateY(30px); transition: all 0.8s ease; }
    .reveal.active { opacity: 1; transform: translateY(0); }

    @media(max-width: 900px) {
      .hero { grid-template-columns: 1fr; text-align: center; gap: 2rem; }
      .hero-buttons { justify-content: center; flex-direction: column; }
      .trust-stats { justify-content: center; flex-wrap: wrap; }
      .nav-links { display: none; position: absolute; top: 100%; left: 0; right: 0; background: var(--bg); flex-direction: column; padding: 2rem; box-shadow: 0 10px 20px rgba(0,0,0,0.1); }
      .nav-links.active { display: flex; }
      .mobile-menu-btn { display: block; }
    }
  </style>
</head>
<body>

  <header>
    <div class="container header-content">
      <a href="#" class="logo">
        <i data-lucide="smile" style="color:var(--primary)"></i> SmileCare
      </a>
      <nav class="nav-links" id="navLinks">
        <a href="#services">Services</a>
        <a href="#dentists">Our Dentists</a>
        <a href="#why-us">Why Us</a>
        <a href="#testimonials">Testimonials</a>
        <a href="#faq">FAQ</a>
        <button class="clay-btn primary open-booking">Book Appointment</button>
      </nav>
      <button class="mobile-menu-btn" id="mobileMenuBtn"><i data-lucide="menu"></i></button>
    </div>
  </header>

  <section class="container py-20 hero reveal">
    <div>
      <h1>A Healthier Smile Starts Here.</h1>
      <p>Personalized dental care, modern treatments, and a comfortable experience for the whole family in the heart of Karachi.</p>
      <div class="hero-buttons">
        <button class="clay-btn primary open-booking">Book Your Visit</button>
        <a href="#services" class="clay-btn">Explore Services</a>
      </div>
      <div class="trust-stats">
        <div class="stat-item"><strong>10+</strong><span>Years Exp. *</span></div>
        <div class="stat-item"><strong>5,000+</strong><span>Smiles *</span></div>
        <div class="stat-item"><strong>4.9/5</strong><span>Rating *</span></div>
      </div>
      <p style="font-size: 0.75rem; margin-top: 10px; color: #94a3b8;">* Demo statistics for design preview</p>
    </div>
    <div class="hero-image">
      <img src="https://images.unsplash.com/photo-1606811841689-23dfddce3e95?w=800&q=80" alt="Modern Dental Clinic Room">
    </div>
  </section>

  <section id="services" class="container py-20 reveal">
    <div class="text-center">
      <h2 class="section-title">Our Dental Services</h2>
      <p class="section-subtitle">Comprehensive care tailored to your unique smile. Demo prices shown in PKR.</p>
    </div>
    <div class="grid-3" id="servicesGrid">
      <!-- Loaded via JS -->
    </div>
  </section>

  <section id="dentists" class="container py-20 reveal">
    <div class="text-center">
      <h2 class="section-title">Meet Our Dentists</h2>
      <p class="section-subtitle">Experienced professionals dedicated to your comfort and health.</p>
    </div>
    <div class="grid-3" id="dentistsGrid">
      <!-- Loaded via JS -->
    </div>
  </section>

  <section id="why-us" class="container py-20 reveal">
    <div class="text-center">
      <h2 class="section-title">Why Choose SmileCare?</h2>
    </div>
    <div class="grid-4 text-center">
      <div class="clay-card">
        <i data-lucide="shield-check" class="service-icon" style="box-shadow:none;"></i>
        <h3>Patient-First Care</h3>
        <p>Your comfort is our top priority.</p>
      </div>
      <div class="clay-card">
        <i data-lucide="zap" class="service-icon" style="box-shadow:none;"></i>
        <h3>Modern Equipment</h3>
        <p>Latest dental technology for precision.</p>
      </div>
      <div class="clay-card">
        <i data-lucide="credit-card" class="service-icon" style="box-shadow:none;"></i>
        <h3>Transparent Pricing</h3>
        <p>No hidden fees. Sample pricing upfront.</p>
      </div>
      <div class="clay-card">
        <i data-lucide="calendar-check" class="service-icon" style="box-shadow:none;"></i>
        <h3>Easy Online Booking</h3>
        <p>Book instantly 24/7.</p>
      </div>
    </div>
  </section>

  <section id="how-it-works" class="container py-20 reveal text-center">
    <h2 class="section-title">How Booking Works</h2>
    <div class="grid-3" style="margin-top: 3rem;">
      <div>
        <div class="service-icon">1</div>
        <h3>Choose Service</h3>
        <p>Select what you need help with.</p>
      </div>
      <div>
        <div class="service-icon">2</div>
        <h3>Pick Date & Dentist</h3>
        <p>Find a convenient time slot.</p>
      </div>
      <div>
        <div class="service-icon">3</div>
        <h3>Confirm Booking</h3>
        <p>Enter details and get your reference.</p>
      </div>
    </div>
  </section>

  <section id="testimonials" class="container py-20 reveal">
    <div class="text-center">
      <h2 class="section-title">Patient Stories</h2>
      <p class="section-subtitle">Demo testimonials shown for design preview only.</p>
    </div>
    <div class="grid-3">
      <div class="clay-card">
        <div style="color:#fbbf24; margin-bottom:10px;">★★★★★</div>
        <p>"The best dental experience I've ever had. Dr. Ayesha is incredibly gentle and the clinic is spotless."</p>
        <strong style="display:block; margin-top:15px;">- Fatima R.</strong>
      </div>
      <div class="clay-card">
        <div style="color:#fbbf24; margin-bottom:10px;">★★★★★</div>
        <p>"Booking online was so easy. No waiting on the phone. Highly recommend SmileCare!"</p>
        <strong style="display:block; margin-top:15px;">- Usman A.</strong>
      </div>
      <div class="clay-card">
        <div style="color:#fbbf24; margin-bottom:10px;">★★★★★</div>
        <p>"Dr. Hamza fixed my braces perfectly. The transparent pricing really helped me plan."</p>
        <strong style="display:block; margin-top:15px;">- Zainab S.</strong>
      </div>
    </div>
  </section>

  <section id="faq" class="container py-20 reveal">
    <div class="text-center">
      <h2 class="section-title">Frequently Asked Questions</h2>
    </div>
    <div style="max-width: 800px; margin: 0 auto;">
      <div class="faq-item">
        <button class="faq-q">How do I book an appointment? <i data-lucide="chevron-down"></i></button>
        <div class="faq-a"><p>Click the "Book Appointment" button, select your service, choose a dentist and time, and enter your details.</p></div>
      </div>
      <div class="faq-item">
        <button class="faq-q">Can I request a specific dentist? <i data-lucide="chevron-down"></i></button>
        <div class="faq-a"><p>Yes, you can select your preferred dentist during step 2 of the booking process.</p></div>
      </div>
      <div class="faq-item">
        <button class="faq-q">How to reschedule or cancel? <i data-lucide="chevron-down"></i></button>
        <div class="faq-a"><p>Please call us at our demo number +92 300 1234567 with your booking reference to cancel or reschedule.</p></div>
      </div>
    </div>
  </section>

  <section id="contact" class="container py-20 reveal">
    <div class="clay-card grid-3" style="align-items: center;">
      <div style="grid-column: span 2;">
        <h2 class="section-title" style="font-size: 2rem;">Contact Our Clinic</h2>
        <p style="margin-bottom: 10px;"><strong>Address:</strong> 123 Blossom Avenue, Clifton, Karachi, Pakistan</p>
        <p style="margin-bottom: 10px;"><strong>Phone:</strong> +92 300 1234567 (Demo)</p>
        <p style="margin-bottom: 10px;"><strong>Email:</strong> hello@smilecare-demo.example</p>
        <p style="margin-bottom: 20px;"><strong>Hours:</strong> Mon - Sat: 9:00 AM - 8:00 PM | Sun: Closed</p>
        <p style="font-size: 0.85rem; color: var(--text-light);">* All contact info is sample data.</p>
      </div>
      <div class="text-center">
        <div style="width:100%; height: 200px; background: var(--bg); border-radius: var(--radius-sm); display:flex; align-items:center; justify-content:center; box-shadow: var(--shadow-inner);">
          <i data-lucide="map-pin" style="width:48px; height:48px; color:var(--primary);"></i>
          <span style="margin-left:10px; font-weight:bold;">Clifton, Karachi</span>
        </div>
      </div>
    </div>
  </section>

  <footer>
    <div class="container">
      <h3 style="color:var(--primary); margin-bottom:10px;"><i data-lucide="smile"></i> SmileCare</h3>
      <p style="color:var(--text-light); margin-bottom:20px;">Your Smile, Our Passion.</p>
      <div style="display:flex; justify-content:center; gap:20px; font-size:0.9rem; margin-bottom:20px;">
        <a href="#" style="color:var(--text);">Privacy Policy Modal</a>
        <a href="#" style="color:var(--text);">Terms of Service</a>
      </div>
      <p style="font-size: 0.8rem; color: #94a3b8;">&copy; 2026 SmileCare Dental Clinic (Demo Project). Timezone: Asia/Karachi.</p>
    </div>
  </footer>

  <!-- Booking Modal -->
  <div class="modal-overlay" id="bookingModal">
    <div class="clay-card booking-modal">
      <button class="close-modal" id="closeModal"><i data-lucide="x"></i></button>
      <h2 class="text-center" style="margin-bottom: 5px;">Book Appointment</h2>
      <p class="text-center section-subtitle" style="margin-bottom: 20px;" id="wizardSubtitle">Step 1: Choose Service</p>
      
      <!-- Progress -->
      <div style="display:flex; gap:10px; margin-bottom: 20px; justify-content:center;">
        <div style="width:40px; height:8px; border-radius:4px; background:var(--primary);" id="prog1"></div>
        <div style="width:40px; height:8px; border-radius:4px; background:var(--bg); box-shadow:var(--shadow-inner);" id="prog2"></div>
        <div style="width:40px; height:8px; border-radius:4px; background:var(--bg); box-shadow:var(--shadow-inner);" id="prog3"></div>
        <div style="width:40px; height:8px; border-radius:4px; background:var(--bg); box-shadow:var(--shadow-inner);" id="prog4"></div>
      </div>

      <!-- Step 1: Service -->
      <div class="wizard-step active" id="step1">
        <div class="grid-3" id="wizardServicesGrid" style="gap:15px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));">Loading...</div>
      </div>

      <!-- Step 2: Dentist -->
      <div class="wizard-step" id="step2">
        <div class="grid-3" id="wizardDentistsGrid" style="gap:15px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));">Loading...</div>
        <div style="margin-top:20px; display:flex; justify-content:space-between;">
          <button class="clay-btn" onclick="prevStep(1)">Back</button>
        </div>
      </div>

      <!-- Step 3: Date & Time -->
      <div class="wizard-step" id="step3">
        <label style="font-weight:700; display:block; margin-bottom:10px;">Select Date (Mon-Sat)</label>
        <input type="date" id="bookingDate" class="clay-input" min="">
        <div id="slotsContainer" class="hidden">
          <label style="font-weight:700; display:block; margin-top:10px;">Available Times</label>
          <div class="slots-grid" id="slotsGrid"></div>
        </div>
        <p id="slotsError" style="color:#ef4444; font-size:0.9rem; margin-top:10px;"></p>
        <div style="margin-top:20px; display:flex; justify-content:space-between;">
          <button class="clay-btn" onclick="prevStep(2)">Back</button>
          <button class="clay-btn primary" id="btnNextTo4" disabled onclick="nextStep(4)">Continue</button>
        </div>
      </div>

      <!-- Step 4: Details -->
      <div class="wizard-step" id="step4">
        <form id="bookingForm" onsubmit="submitBooking(event)">
          <input type="text" id="pName" class="clay-input" placeholder="Full Name" required>
          <input type="tel" id="pPhone" class="clay-input" placeholder="Phone Number" required>
          <input type="email" id="pEmail" class="clay-input" placeholder="Email (Optional)">
          <textarea id="pNotes" class="clay-input" placeholder="Reason for visit (Optional)" rows="2"></textarea>
          <div style="margin-top:20px; display:flex; justify-content:space-between;">
            <button type="button" class="clay-btn" onclick="prevStep(3)">Back</button>
            <button type="submit" class="clay-btn primary" id="btnSubmit">Confirm Booking</button>
          </div>
        </form>
      </div>

      <!-- Step 5: Success -->
      <div class="wizard-step text-center" id="step5">
        <i data-lucide="check-circle" style="width:64px; height:64px; color:#10b981; margin:0 auto 20px;"></i>
        <h2>Booking Confirmed!</h2>
        <p style="margin:15px 0;">Your reference number is:</p>
        <div style="font-size:2rem; font-weight:800; color:var(--primary); letter-spacing:2px; margin-bottom:20px;" id="refCode"></div>
        <p style="font-size:0.9rem; color:var(--text-light); margin-bottom:20px;">Please save this reference. We look forward to seeing you at SmileCare Dental Clinic.</p>
        <button class="clay-btn primary" onclick="closeBookingModal()">Done</button>
      </div>

    </div>
  </div>

  <script>
    lucide.createIcons();
    
    // --- State & Globals ---
    let servicesData = [];
    let dentistsData = [];
    let bookingState = { serviceId: null, dentistId: null, date: null, time: null };

    // Set min date to today in Karachi
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Karachi"}));
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    document.getElementById('bookingDate').min = \`\${yyyy}-\${mm}-\${dd}\`;

    // --- Data Fetching ---
    async function loadInitialData() {
      try {
        const [resS, resD] = await Promise.all([ fetch('/api/services'), fetch('/api/dentists') ]);
        servicesData = await resS.json();
        dentistsData = await resD.json();
        renderPublicUI();
      } catch(e) { console.error("Error loading data", e); }
    }

    function renderPublicUI() {
      // Services
      const sGrid = document.getElementById('servicesGrid');
      sGrid.innerHTML = servicesData.map(s => \`
        <div class="clay-card service-card">
          <i data-lucide="\${s.icon || 'smile'}" class="service-icon"></i>
          <h3>\${s.name}</h3>
          <p>\${s.description}</p>
          <div class="service-price">PKR \${s.price.toLocaleString()}</div>
          <p style="font-size:0.85rem; color:var(--text-light); margin-bottom:15px;">\${s.durationMinutes} mins</p>
          <button class="clay-btn" onclick="startBooking('\${s._id}')">Book Service</button>
        </div>
      \`).join('');
      
      // Dentists
      const dGrid = document.getElementById('dentistsGrid');
      dGrid.innerHTML = dentistsData.map(d => \`
        <div class="clay-card dentist-card text-center">
          <img src="\${d.imageUrl}" alt="\${d.name}">
          <h3>\${d.name}</h3>
          <p style="color:var(--primary); font-weight:600; margin-bottom:5px;">\${d.specialization}</p>
          <p style="font-size:0.9rem; color:var(--text-light); margin-bottom:15px;">Exp: \${d.experience} (Demo)</p>
          <button class="clay-btn" onclick="startBooking(null, '\${d._id}')">Book Appointment</button>
        </div>
      \`).join('');
      lucide.createIcons();
    }

    // --- Interactions ---
    document.getElementById('mobileMenuBtn').addEventListener('click', () => {
      document.getElementById('navLinks').classList.toggle('active');
    });

    document.querySelectorAll('.faq-q').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = btn.parentElement;
        item.classList.toggle('open');
      });
    });

    const observer = new IntersectionObserver(entries => {
      entries.forEach(e => { if(e.isIntersecting) e.target.classList.add('active'); });
    }, { threshold: 0.1 });
    document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

    // --- Booking Logic ---
    const modal = document.getElementById('bookingModal');
    document.querySelectorAll('.open-booking').forEach(b => b.addEventListener('click', () => startBooking()));
    document.getElementById('closeModal').addEventListener('click', closeBookingModal);

    function startBooking(sId = null, dId = null) {
      bookingState = { serviceId: sId, dentistId: dId, date: null, time: null };
      modal.classList.add('active');
      renderWizardServices();
      renderWizardDentists();
      
      if(sId && dId) nextStep(3);
      else if(sId) nextStep(2);
      else nextStep(1);
    }

    function closeBookingModal() {
      modal.classList.remove('active');
      setTimeout(() => { nextStep(1); }, 300);
    }

    function renderWizardServices() {
      document.getElementById('wizardServicesGrid').innerHTML = servicesData.map(s => \`
        <div class="clay-card selectable-card \${bookingState.serviceId === s._id ? 'selected' : ''}" onclick="selectService('\${s._id}')">
          <h4 style="margin-bottom:5px;">\${s.name}</h4>
          <p style="font-size:0.85rem;">PKR \${s.price.toLocaleString()} • \${s.durationMinutes}m</p>
        </div>
      \`).join('');
    }

    function renderWizardDentists() {
      document.getElementById('wizardDentistsGrid').innerHTML = dentistsData.map(d => \`
        <div class="clay-card selectable-card \${bookingState.dentistId === d._id ? 'selected' : ''}" onclick="selectDentist('\${d._id}')">
          <h4 style="margin-bottom:5px;">\${d.name}</h4>
          <p style="font-size:0.85rem; color:var(--text-light);">\${d.specialization}</p>
        </div>
      \`).join('');
    }

    function selectService(id) { bookingState.serviceId = id; renderWizardServices(); setTimeout(()=>nextStep(2), 200); }
    function selectDentist(id) { bookingState.dentistId = id; renderWizardDentists(); setTimeout(()=>nextStep(3), 200); }

    document.getElementById('bookingDate').addEventListener('change', async (e) => {
      const date = e.target.value;
      const day = new Date(date).getDay();
      if(day === 0) { // Sunday
        document.getElementById('slotsError').textContent = "Clinic is closed on Sundays.";
        document.getElementById('slotsContainer').classList.add('hidden');
        return;
      }
      bookingState.date = date;
      document.getElementById('slotsError').textContent = "Loading slots...";
      document.getElementById('slotsContainer').classList.add('hidden');
      
      try {
        const res = await fetch(\`/api/availability?date=\${date}&dentistId=\${bookingState.dentistId}&serviceId=\${bookingState.serviceId}\`);
        const data = await res.json();
        document.getElementById('slotsError').textContent = "";
        
        if(!data.slots || data.slots.length === 0) {
          document.getElementById('slotsError').textContent = "No available slots for this date.";
          return;
        }
        
        document.getElementById('slotsGrid').innerHTML = data.slots.map(time => \`
          <button class="slot-btn \${bookingState.time === time ? 'selected' : ''}" onclick="selectTime('\${time}')">\${time}</button>
        \`).join('');
        document.getElementById('slotsContainer').classList.remove('hidden');
      } catch(err) {
        document.getElementById('slotsError').textContent = "Failed to load availability.";
      }
    });

    function selectTime(time) {
      bookingState.time = time;
      document.querySelectorAll('.slot-btn').forEach(b => {
        b.classList.toggle('selected', b.textContent === time);
      });
      document.getElementById('btnNextTo4').disabled = false;
    }

    function nextStep(step) { updateWizard(step); }
    function prevStep(step) { updateWizard(step); }

    function updateWizard(step) {
      document.querySelectorAll('.wizard-step').forEach(el => el.classList.remove('active'));
      document.getElementById('step' + step).classList.add('active');
      
      const titles = ["Choose Service", "Select Dentist", "Date & Time", "Your Details", "Confirmed"];
      document.getElementById('wizardSubtitle').textContent = "Step " + step + ": " + titles[step-1];
      
      for(let i=1; i<=4; i++) {
        const p = document.getElementById('prog'+i);
        if(p) {
          if(i <= step) { p.style.background = 'var(--primary)'; p.style.boxShadow = 'none'; }
          else { p.style.background = 'var(--bg)'; p.style.boxShadow = 'var(--shadow-inner)'; }
        }
      }
    }

    async function submitBooking(e) {
      e.preventDefault();
      const btn = document.getElementById('btnSubmit');
      btn.textContent = "Booking..."; btn.disabled = true;

      const payload = {
        patientName: document.getElementById('pName').value,
        phone: document.getElementById('pPhone').value,
        email: document.getElementById('pEmail').value,
        notes: document.getElementById('pNotes').value,
        serviceId: bookingState.serviceId,
        dentistId: bookingState.dentistId,
        appointmentDate: bookingState.date,
        startTime: bookingState.time
      };

      try {
        const res = await fetch('/api/appointments', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if(!res.ok) throw new Error(data.error || "Booking failed");
        
        document.getElementById('refCode').textContent = data.appointment.bookingReference;
        nextStep(5);
        document.getElementById('bookingForm').reset();
        bookingState.time = null;
      } catch(err) {
        alert(err.message);
      } finally {
        btn.textContent = "Confirm Booking"; btn.disabled = false;
      }
    }

    loadInitialData();
  </script>
</body>
</html>`;

app.get('/', (req, res) => res.send(PUBLIC_HTML));

module.exports = app;
