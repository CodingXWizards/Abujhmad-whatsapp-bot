// server.js - Main Express Server with Queue System
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const Queue = require('bull');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Supabase Setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Redis Queue Setup (using Bull)
const messageQueue = new Queue('whatsapp-messages', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// WhatsApp Client
let whatsappClient = null;
let isClientReady = false;
let qrCodeData = null;

// Initialize WhatsApp Client
const initializeWhatsAppClient = () => {
  whatsappClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: './whatsapp-session',
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
  });

  // QR Code Generation
  whatsappClient.on('qr', async (qr) => {
    console.log('📱 QR Code received, generating...');
    try {
      qrCodeData = await qrcode.toDataURL(qr);
      console.log('✅ QR Code generated successfully');
    } catch (err) {
      console.error('❌ Error generating QR code:', err);
    }
  });

  // Client Ready
  whatsappClient.on('ready', () => {
    console.log('✅ WhatsApp client is ready!');
    isClientReady = true;
    qrCodeData = null;
  });

  // Authentication
  whatsappClient.on('authenticated', () => {
    console.log('✅ WhatsApp client authenticated');
  });

  // Disconnection
  whatsappClient.on('disconnected', (reason) => {
    console.log('❌ WhatsApp client disconnected:', reason);
    isClientReady = false;
    qrCodeData = null;
  });

  // Initialize
  whatsappClient.initialize().catch((err) => {
    console.error('❌ Error initializing WhatsApp client:', err);
  });
};

// Helper Functions
function isOpenCategory(city, gender) {
  const bastarCities = [
    'Jagdalpur',
    'Kondagaon',
    'Kanker',
    'Bijapur',
    'Dantewada',
    'Sukma',
    'Bastar',
  ];
  const normalizedGender = gender ? gender.toUpperCase() : '';
  return (
    city !== 'Narayanpur' &&
    !bastarCities.includes(city) &&
    normalizedGender === 'MALE'
  );
}

function getRaceCategoryDisplay(city, gender, isEnglish) {
  const bastarCities = [
    'Jagdalpur',
    'Kondagaon',
    'Kanker',
    'Bijapur',
    'Dantewada',
    'Sukma',
    'Bastar',
  ];
  const normalizedGender = gender ? gender.toUpperCase() : '';

  if (city === 'Narayanpur') {
    if (normalizedGender === 'MALE') {
      return isEnglish ? 'Narayanpur Open 21 KM' : 'नारायणपुर ओपन 21 किमी';
    } else if (normalizedGender === 'FEMALE') {
      return isEnglish ? 'Narayanpur Women 21 KM' : 'नारायणपुर महिला 21 किमी';
    }
  } else if (bastarCities.includes(city)) {
    if (normalizedGender === 'MALE') {
      return isEnglish ? 'Bastar Men 21 KM' : 'बस्तर पुरुष 21 किमी';
    } else if (normalizedGender === 'FEMALE') {
      return isEnglish ? 'Bastar Women 21 KM' : 'बस्तर महिला 21 किमी';
    }
  } else {
    if (normalizedGender === 'MALE') {
      return isEnglish ? 'Open 21 KM' : 'ओपन 21 किमी';
    } else if (normalizedGender === 'FEMALE') {
      return isEnglish ? 'Women Open 21 KM' : 'महिला ओपन 21 किमी';
    }
  }

  return isEnglish ? '21 KM' : '21 किमी';
}

function generateMessage(data, useEnglish) {
  const {
    firstName,
    lastName,
    raceCategory,
    tShirtSize,
    bibNumber,
    wantsTshirt,
    paymentStatus,
  } = data;

  if (useEnglish) {
    const tshirtLine =
      wantsTshirt === true || wantsTshirt === 'true'
        ? `👕 T-Shirt Size: ${tShirtSize || 'N/A'}`
        : '';

    const offlinePaymentMsg =
      paymentStatus === 'OFFLINE'
        ? '\n💳 You have chosen offline payment method.'
        : '';

    return `*Hello* ${firstName || ''} Sir! 🙏

🎉 Congratulations! Your registration is successful 🎉

Your registration for Abujhmad Peace Half Marathon 2026 has been completed successfully.

🏃‍♂️ Race Date: 25th January 2026
🚶‍♀️ Race Category: *${raceCategory}*
${tshirtLine}

🔢 Your Registration Number (BIB): *${bibNumber || 'N/A'}*${offlinePaymentMsg}

🚨 Registration closing soon 🚨

🔗 Stay connected with us:
📸 Instagram: https://www.instagram.com/abujhmad_marathon?igsh=OGdvdDFqczZwemQ3
💬 WhatsApp Group: https://chat.whatsapp.com/Llhu0HQlPZS5Egf26WtjAS
🌐 Website: https://runabhujhmad.in/
📧 Email: support@runabhujhmad.in

*🕊️ "Let's take steps together and connect Abujhmad with us!" 🏃‍♀️🏃‍♂️*`;
  } else {
    const tshirtLine =
      wantsTshirt === true || wantsTshirt === 'true'
        ? `👕 टी-शर्ट साइज: ${tShirtSize || 'N/A'}`
        : '';

    const offlinePaymentMsg =
      paymentStatus === 'OFFLINE'
        ? '\n💳 आपने ऑफलाइन भुगतान माध्यम चुना है।'
        : '';

    return `*सेवा जोहार* ${firstName || ''} जी! 🙏

🎉 बधाई हो! आपका पंजीकरण सफल रहा 🎉

अबूझमाड़ पीस हाफ मैराथन 2026 में आपका पंजीकरण सफलतापूर्वक पूरा हो गया है। 

🏃‍♂️ रेस की तारीख: 25 जनवरी 2026
🚶‍♀️ रेस श्रेणी: *${raceCategory}*
${tshirtLine}

🔢 आपकी पंजीकरण संख्या (BIB): *${bibNumber || 'N/A'}*${offlinePaymentMsg}

🚨 पंजीकरण जल्द बंद हो रहा है 🚨

🔗 हमसे जुड़े रहें:
📸 Instagram: https://www.instagram.com/abujhmad_marathon?igsh=OGdvdDFqczZwemQ3
💬 WhatsApp ग्रुप: https://chat.whatsapp.com/Llhu0HQlPZS5Egf26WtjAS
🌐 वेबसाइट: https://runabhujhmad.in/
📧 ईमेल: support@runabhujhmad.in

*🕊️ "आओ मिलकर कदम बढ़ाएं, अबूझमाड़ को जोड़ें हमारे साथ!" 🏃‍♀️🏃‍♂️*`;
  }
}

// Queue Processor
messageQueue.process(async (job) => {
  const { phoneNumber, data } = job.data;

  console.log(`📤 Processing message for ${data.firstName} ${data.lastName}`);

  if (!isClientReady) {
    throw new Error('WhatsApp client is not ready');
  }

  try {
    // Format phone number
    let formattedNumber = phoneNumber.replace(/\D/g, '');
    if (!formattedNumber.startsWith('91') && formattedNumber.length === 10) {
      formattedNumber = '91' + formattedNumber;
    }
    const chatId = `${formattedNumber}@c.us`;

    // Determine language
    const useEnglish = isOpenCategory(data.city, data.gender);
    const raceCategory = getRaceCategoryDisplay(
      data.city,
      data.gender,
      useEnglish
    );

    // Generate message
    const message = generateMessage(
      {
        ...data,
        raceCategory,
      },
      useEnglish
    );

    // Send message
    const response = await whatsappClient.sendMessage(chatId, message);

    console.log(`✅ Message sent to ${data.firstName} ${data.lastName}`);

    // Update database
    await supabase
      .schema('marathon')
      .from('registrations_2026')
      .update({ registration_confirmation_wp: 'true' })
      .eq('mobile', phoneNumber);

    // Log to marathon_messages
    await supabase.from('marathon_messages').insert([
      {
        phone_number: phoneNumber,
        first_name: data.firstName,
        last_name: data.lastName,
        race_category: data.raceCategory,
        tshirt_size: data.tShirtSize,
        bib_number: data.bibNumber,
        city: data.city,
        message_id: response.id._serialized,
        status: 'sent',
        sent_at: new Date().toISOString(),
      },
    ]);

    return { success: true, messageId: response.id._serialized };
  } catch (error) {
    console.error(`❌ Error sending message:`, error.message);

    // Check if number doesn't exist
    const numberNotExist = /No LID for user|not registered/i.test(
      error.message
    );

    if (numberNotExist) {
      await supabase
        .schema('marathon')
        .from('registrations_2026')
        .update({ registration_confirmation_wp: 'not exist' })
        .eq('mobile', phoneNumber);
    }

    // Log failed attempt
    await supabase.from('marathon_messages').insert([
      {
        phone_number: phoneNumber,
        first_name: data.firstName,
        last_name: data.lastName,
        race_category: data.raceCategory,
        tshirt_size: data.tShirtSize,
        bib_number: data.bibNumber,
        city: data.city,
        status: numberNotExist ? 'not_exist' : 'failed',
        error_message: error.message,
        sent_at: new Date().toISOString(),
      },
    ]);

    throw error;
  }
});

// API Routes

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    whatsappReady: isClientReady,
    needsQR: !!qrCodeData,
    timestamp: new Date().toISOString(),
  });
});

// QR Code endpoint
app.get('/api/qr', (req, res) => {
  if (qrCodeData) {
    res.json({ qrCode: qrCodeData });
  } else if (isClientReady) {
    res.json({ message: 'Client is already authenticated' });
  } else {
    res.status(404).json({ error: 'QR code not available yet' });
  }
});

// Send message endpoint (from your website)
app.post('/send-marathon-message', async (req, res) => {
  try {
    const {
      phoneNumber,
      raceCategory,
      tShirtSize,
      identificationNumber,
      firstName,
      lastName,
      city,
      gender,
      wantsTshirt,
      paymentStatus,
    } = req.body;

    // Validate required fields
    if (!phoneNumber || !firstName || !lastName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
      });
    }

    // Check if WhatsApp is ready
    if (!isClientReady) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp client is not ready. Please scan QR code.',
        needsQR: !!qrCodeData,
      });
    }

    // Add to queue with delay
    const job = await messageQueue.add(
      {
        phoneNumber,
        data: {
          firstName,
          lastName,
          raceCategory,
          tShirtSize,
          bibNumber: identificationNumber,
          city,
          gender,
          wantsTshirt,
          paymentStatus,
        },
      },
      {
        delay: 0, // Immediate processing, but queue will handle rate limiting
      }
    );

    res.json({
      success: true,
      message: 'Message queued successfully',
      jobId: job.id,
    });
  } catch (error) {
    console.error('Error queueing message:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Bulk send endpoint (for existing registrations)
app.post('/api/bulk-send', async (req, res) => {
  try {
    if (!isClientReady) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp client is not ready',
      });
    }

    // Fetch pending participants
    const { data: participants, error } = await supabase
      .schema('marathon')
      .from('registrations_2026')
      .select('*')
      .in('payment_status', ['DONE', 'OFFLINE'])
      .is('registration_confirmation_wp', null)
      .gt('created_at', '2025-12-01T00:00:00Z');

    if (error) throw error;

    if (!participants || participants.length === 0) {
      return res.json({
        success: true,
        message: 'No pending participants found',
        count: 0,
      });
    }

    // Add all to queue with staggered delays (30-45 seconds between each)
    const jobs = [];
    for (let i = 0; i < participants.length; i++) {
      const participant = participants[i];
      const delay = i * (30000 + Math.random() * 15000); // 30-45 seconds

      const job = await messageQueue.add(
        {
          phoneNumber: participant.mobile,
          data: {
            firstName: participant.first_name,
            lastName: participant.last_name,
            raceCategory: participant.race_category,
            tShirtSize: participant.t_shirt_size,
            bibNumber: participant.bib_num,
            city: participant.city,
            gender: participant.gender,
            wantsTshirt: participant.wants_tshirt,
            paymentStatus: participant.payment_status,
          },
        },
        { delay }
      );

      jobs.push(job.id);
    }

    res.json({
      success: true,
      message: `${participants.length} messages queued successfully`,
      count: participants.length,
      jobIds: jobs,
    });
  } catch (error) {
    console.error('Error in bulk send:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Queue stats endpoint
app.get('/api/queue-stats', async (req, res) => {
  try {
    const [waiting, active, completed, failed] = await Promise.all([
      messageQueue.getWaitingCount(),
      messageQueue.getActiveCount(),
      messageQueue.getCompletedCount(),
      messageQueue.getFailedCount(),
    ]);

    res.json({
      waiting,
      active,
      completed,
      failed,
      total: waiting + active + completed + failed,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    whatsapp: isClientReady ? 'ready' : 'not ready',
    timestamp: new Date().toISOString(),
  });
});

// Admin Dashboard HTML
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>WhatsApp Marathon Bot Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        h1 {
            color: #667eea;
            margin-bottom: 30px;
            text-align: center;
        }
        .status {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .status-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        .status-card h3 {
            font-size: 14px;
            margin-bottom: 10px;
            opacity: 0.9;
        }
        .status-card p {
            font-size: 32px;
            font-weight: bold;
        }
        .qr-section {
            text-align: center;
            margin-bottom: 30px;
        }
        .qr-section img {
            max-width: 300px;
            border: 5px solid #667eea;
            border-radius: 10px;
        }
        button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 15px 30px;
            border-radius: 10px;
            font-size: 16px;
            cursor: pointer;
            margin: 10px;
            transition: transform 0.2s;
        }
        button:hover {
            transform: translateY(-2px);
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .actions {
            text-align: center;
            margin-top: 30px;
        }
        .indicator {
            display: inline-block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            margin-right: 8px;
        }
        .indicator.ready {
            background: #10b981;
            box-shadow: 0 0 10px #10b981;
        }
        .indicator.not-ready {
            background: #ef4444;
            box-shadow: 0 0 10px #ef4444;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🏃‍♂️ WhatsApp Marathon Bot Dashboard</h1>
        
        <div class="status">
            <div class="status-card">
                <h3>WhatsApp Status</h3>
                <p id="whatsapp-status">
                    <span class="indicator not-ready"></span>
                    <span>Checking...</span>
                </p>
            </div>
            <div class="status-card">
                <h3>Waiting</h3>
                <p id="waiting">-</p>
            </div>
            <div class="status-card">
                <h3>Active</h3>
                <p id="active">-</p>
            </div>
            <div class="status-card">
                <h3>Completed</h3>
                <p id="completed">-</p>
            </div>
            <div class="status-card">
                <h3>Failed</h3>
                <p id="failed">-</p>
            </div>
        </div>

        <div id="qr-section" class="qr-section" style="display: none;">
            <h2>Scan QR Code with WhatsApp</h2>
            <img id="qr-code" src="" alt="QR Code">
        </div>

        <div class="actions">
            <button id="bulk-send-btn" onclick="bulkSend()" disabled>
                📤 Send to All Pending Registrations
            </button>
            <button onclick="refreshStats()">
                🔄 Refresh Stats
            </button>
        </div>
    </div>

    <script>
        async function checkStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                const statusEl = document.getElementById('whatsapp-status');
                const bulkBtn = document.getElementById('bulk-send-btn');
                
                if (data.whatsappReady) {
                    statusEl.innerHTML = '<span class="indicator ready"></span><span>Ready</span>';
                    bulkBtn.disabled = false;
                } else {
                    statusEl.innerHTML = '<span class="indicator not-ready"></span><span>Not Ready</span>';
                    bulkBtn.disabled = true;
                }

                if (data.needsQR) {
                    await showQR();
                } else {
                    document.getElementById('qr-section').style.display = 'none';
                }
            } catch (error) {
                console.error('Error checking status:', error);
            }
        }

        async function showQR() {
            try {
                const res = await fetch('/api/qr');
                const data = await res.json();
                
                if (data.qrCode) {
                    document.getElementById('qr-code').src = data.qrCode;
                    document.getElementById('qr-section').style.display = 'block';
                }
            } catch (error) {
                console.error('Error fetching QR:', error);
            }
        }

        async function refreshStats() {
            try {
                const res = await fetch('/api/queue-stats');
                const data = await res.json();
                
                document.getElementById('waiting').textContent = data.waiting;
                document.getElementById('active').textContent = data.active;
                document.getElementById('completed').textContent = data.completed;
                document.getElementById('failed').textContent = data.failed;
            } catch (error) {
                console.error('Error fetching stats:', error);
            }
        }

        async function bulkSend() {
            if (!confirm('Are you sure you want to send messages to all pending registrations?')) {
                return;
            }

            try {
                const btn = document.getElementById('bulk-send-btn');
                btn.disabled = true;
                btn.textContent = '⏳ Queueing messages...';

                const res = await fetch('/api/bulk-send', { method: 'POST' });
                const data = await res.json();

                if (data.success) {
                    alert(\`✅ \${data.count} messages queued successfully!\`);
                } else {
                    alert(\`❌ Error: \${data.error}\`);
                }

                btn.disabled = false;
                btn.textContent = '📤 Send to All Pending Registrations';
                refreshStats();
            } catch (error) {
                console.error('Error in bulk send:', error);
                alert('❌ Error: ' + error.message);
            }
        }

        // Auto-refresh
        setInterval(() => {
            checkStatus();
            refreshStats();
        }, 3000);

        // Initial load
        checkStatus();
        refreshStats();
    </script>
</body>
</html>
  `);
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║     🚀 WhatsApp Marathon Bot Server Started                ║
║                                                            ║
║     📍 Server: http://localhost:${PORT}                       ║
║     📊 Dashboard: http://localhost:${PORT}                    ║
║     🔌 API: http://localhost:${PORT}/send-marathon-message    ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);

  // Initialize WhatsApp client
  initializeWhatsAppClient();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  await messageQueue.close();
  if (whatsappClient) {
    await whatsappClient.destroy();
  }
  process.exit(0);
});