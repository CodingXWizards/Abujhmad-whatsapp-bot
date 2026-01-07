const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const { MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

// 🔑 Supabase credentials
const SUPABASE_URL = "https://vknemthgkkbseucxgmyc.supabase.co";
const SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZrbmVtdGhna2tic2V1Y3hnbXljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTMzNTM1OTgsImV4cCI6MjA2ODkyOTU5OH0.HWOJ8ZkkCZLXWbR9x6fNDigEKfTmnmCmVhSOAruN7N0";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 📸 Image paths (place your 3 images in the same directory as this script)
const IMAGE_PATHS = [
  'images/image1.jpeg',
  'images/image2.jpeg',
  'images/image3.jpeg'
];

// 🟢 WhatsApp Client Configuration
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: false,
    timeout: 60000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-infobars",
      "--disable-blink-features=AutomationControlled"
    ]
  }
});

// 📋 Fetch pending participants from Supabase using optimized query
async function fetchParticipants() {
  try {
    console.log('📥 Fetching pending participants from database...');

    // Use raw SQL query to match your exact logic with DISTINCT on last 10 digits
    const { data, error } = await supabase.rpc('get_unique_pending_participants', {});

    if (error) {
      console.log('⚠️ Stored procedure not found, using fallback query...');

      // Fallback: Fetch all pending and deduplicate in code
      const { data: rawData, error: fetchError } = await supabase
        .schema('marathon')
        .from('registrations_2026')
        .select('mobile, first_name, last_name, t_shirt_size, wants_tshirt, city, gender, payment_status, pending_reminder_wp')
        .not('payment_status', 'in', '("DONE","OFFLINE")')
        .or('pending_reminder_wp.is.null,pending_reminder_wp.eq.false')
        .order('created_at', { ascending: false });

      if (fetchError) {
        console.error('❌ Error fetching participants:', fetchError);
        throw fetchError;
      }

      if (!rawData || rawData.length === 0) {
        console.log('⚠️ No pending participants found');
        return [];
      }

      // Deduplicate by last 10 digits and exclude those with completed registrations
      const uniqueParticipants = new Map();
      const completedNumbers = new Set();

      // First pass: collect all completed numbers
      const { data: completedData } = await supabase
        .schema('marathon')
        .from('registrations_2026')
        .select('mobile')
        .in('payment_status', ['DONE', 'OFFLINE']);

      if (completedData) {
        completedData.forEach(record => {
          const normalized = record.mobile.replace(/\D/g, '').slice(-10);
          completedNumbers.add(normalized);
        });
      }

      // Second pass: collect unique pending participants (excluding completed numbers)
      rawData.forEach(record => {
        const normalized = record.mobile.replace(/\D/g, '').slice(-10);

        // Skip if this number has completed registration
        if (completedNumbers.has(normalized)) {
          return;
        }

        // Only keep the first occurrence of each unique number
        if (!uniqueParticipants.has(normalized)) {
          uniqueParticipants.set(normalized, record);
        }
      });

      const filteredData = Array.from(uniqueParticipants.values());
      console.log(`✅ Found ${filteredData.length} unique participants pending registration reminder`);
      return filteredData;
    }

    if (!data || data.length === 0) {
      console.log('⚠️ No pending participants found');
      return [];
    }

    console.log(`✅ Found ${data.length} unique participants pending registration reminder`);
    return data;

  } catch (error) {
    console.error('❌ Database error:', error);
    return [];
  }
}

// Function to determine race category in Hindi based on city and gender
function getRaceCategoryHindi(city, gender) {
  const bastarCities = ["Jagdalpur", "Kondagaon", "Kanker", "Bijapur", "Dantewada", "Sukma", "Bastar"];

  const normalizedGender = gender ? gender.toUpperCase() : "";

  if (city === "Narayanpur") {
    if (normalizedGender === "MALE") {
      return "नारायणपुर ओपन 21 किमी";
    } else if (normalizedGender === "FEMALE") {
      return "नारायणपुर महिला 21 किमी";
    }
  } else if (bastarCities.includes(city)) {
    if (normalizedGender === "MALE") {
      return "बस्तर पुरुष 21 किमी";
    } else if (normalizedGender === "FEMALE") {
      return "बस्तर महिला 21 किमी";
    }
  } else {
    if (normalizedGender === "MALE") {
      return "ओपन 21 किमी";
    } else if (normalizedGender === "FEMALE") {
      return "महिला ओपन 21 किमी";
    }
  }

  return "21 किमी";
}

// Helper function to get random delay (30-45 seconds)
function getRandomDelay(isLidError = false) {
  if (isLidError) {
    return 10000; // 10 seconds for LID errors
  }
  const min = 30000; // 30 seconds
  const max = 45000; // 45 seconds
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Helper function to get random image
function getRandomImage() {
  const randomIndex = Math.floor(Math.random() * IMAGE_PATHS.length);
  const imagePath = IMAGE_PATHS[randomIndex];

  // Check if file exists
  if (fs.existsSync(imagePath)) {
    return MessageMedia.fromFilePath(imagePath);
  } else {
    console.warn(`⚠️ Image not found: ${imagePath}`);
    return null;
  }
}

// Helper function to add slight variations to message
function randomizeMessage(baseMessage) {
  const variations = [
    baseMessage,
    baseMessage.replace('सेवा जोहार', 'नमस्कार'),
    baseMessage.replace('समय सीमित है!', 'जल्दी करें!'),
    baseMessage.replace('मौका न गंवाएं', 'अवसर न चूकें'),
  ];

  return variations[Math.floor(Math.random() * variations.length)];
}

// Function to update all records with same phone number
async function updateAllRecordsForPhone(phoneNumber) {
  try {
    // Normalize to last 10 digits
    const normalized = phoneNumber.replace(/\D/g, '').slice(-10);

    // Get all records with this phone number (matching last 10 digits)
    const { data: allRecords, error: fetchError } = await supabase
      .schema('marathon')
      .from('registrations_2026')
      .select('id, mobile')
      .ilike('mobile', `%${normalized}`);

    if (fetchError) {
      console.error('⚠️ Error fetching records for phone:', fetchError);
      return;
    }

    if (!allRecords || allRecords.length === 0) {
      return;
    }

    // Update all matching records
    for (const record of allRecords) {
      const recordNormalized = record.mobile.replace(/\D/g, '').slice(-10);
      if (recordNormalized === normalized) {
        await supabase
          .schema('marathon')
          .from('registrations_2026')
          .update({ pending_reminder_wp: true })
          .eq('id', record.id);
      }
    }

    console.log(`✅ Updated ${allRecords.length} records for phone ${normalized}`);
  } catch (error) {
    console.error('⚠️ Error updating records:', error);
  }
}

// Function to send reminder message to one participant
async function sendPendingReminder(participant, sentNumbers) {
  try {
    const { 
      mobile: phoneNumber,
      first_name: firstName,
      last_name: lastName,
      t_shirt_size: tShirtSize,
      wants_tshirt: wantsTshirt,
      city,
      gender
    } = participant;

    console.log(`\n📤 Processing: ${firstName} ${lastName} (${phoneNumber})`);

    // Validate phone number
    if (!phoneNumber) {
      console.log(`❌ No phone number for ${firstName} ${lastName}`);
      return {
        success: false,
        phoneNumber: 'N/A',
        error: 'No phone number',
        isLidError: false
      };
    }

    // Normalize phone number (last 10 digits)
    const normalizedNumber = phoneNumber.replace(/\D/g, '').slice(-10);

    // Check if we've already sent to this number in this session
    if (sentNumbers.has(normalizedNumber)) {
      console.log(`⏭️ Skipping ${firstName} ${lastName} - already sent to ${normalizedNumber} in this session`);

      // Still update this record
      await updateAllRecordsForPhone(phoneNumber);

      return {
        success: true,
        phoneNumber,
        error: 'Duplicate - already sent',
        skipped: true,
        isLidError: false
      };
    }

    // Format phone number for WhatsApp
    let formattedNumber = phoneNumber.replace(/\D/g, '');
    if (!formattedNumber.startsWith('91') && formattedNumber.length === 10) {
      formattedNumber = '91' + formattedNumber;
    }
    const chatId = `${formattedNumber}@c.us`;

    // Get race category in Hindi
    const raceCategoryHindi = getRaceCategoryHindi(city, gender);

    // T-shirt size line
    const tshirtLine = (wantsTshirt === true || wantsTshirt === 'true') 
      ? tShirtSize || 'M' 
      : 'M';

    // Construct base message
    const baseMessage = `*सेवा जोहार ${firstName || ''} जी! 🙏*

🏃 *अबूझमाड़ पीस हाफ मैराथन 2026* 🏃
📍 नारायणपुर, छत्तीसगढ़ | 📅 25 जनवरी 2026

आपने अबूझमाड़ पीस हाफ मैराथन 2026 में रुचि दिखाई है, लेकिन आपका पंजीकरण अभी *अधूरा* है!

⏰ *पंजीकरण जल्द ही बंद हो रहे हैं!* ⏰

🎽 *${raceCategoryHindi}* में ${tshirtLine} टी-शर्ट पहनकर दौड़ने का मौका न गंवाएं!

✨ बस्तर के वन्य क्षेत्र से होकर दौड़ने का अवसर
✨ प्रकृति के साथ कदम मिलाने का अनुभव
✨ अबूझमाड़ के हृदय में — छत्तीसगढ़ के हृदय में दौड़

*🕊️ "आओ मिलकर बढ़ाएं कदम, अबूझमाड़ को जोड़ें हमारे साथ!" 🏃♀️🏃♂️*

👉 जल्दी जाइए और पंजीकरण कीजिए: https://runabhujhmad.in/registration 🎯

🔗 हमसे जुड़े रहें:
📸 Instagram: https://www.instagram.com/abujhmad_marathon
💬 WhatsApp: https://chat.whatsapp.com/Llhu0HQlPZS5Egf26WtjAS
📧 ईमेल: support@runabhujhmad.in`;

    // Randomize message
    const message = randomizeMessage(baseMessage);

    // Get random image
    const media = getRandomImage();

    let isLidError = false;

    try {
      let response;

      // Send message with or without image
      if (media) {
        console.log('📸 Sending message with image...');
        response = await client.sendMessage(chatId, media, { caption: message });
      } else {
        console.log('📝 Sending text-only message...');
        response = await client.sendMessage(chatId, message);
      }

      console.log(`✅ Reminder sent to ${firstName} ${lastName} (${phoneNumber})`);

      // Mark this number as sent in this session
      sentNumbers.add(normalizedNumber);

      // Update ALL records with this phone number
      await updateAllRecordsForPhone(phoneNumber);

      return {
        success: true,
        phoneNumber,
        messageId: response.id._serialized,
        isLidError: false
      };

    } catch (sendError) {
      console.log(`❌ Failed for ${phoneNumber}:`, sendError.message);

      // Check if it's a LID error
      if (sendError.message.includes('No LID for user')) {
        isLidError = true;
        console.log(`⚠️ Number not on WhatsApp, marking as attempted: ${phoneNumber}`);

        // Mark this number as sent to avoid retries
        sentNumbers.add(normalizedNumber);

        // Update ALL records with this phone number
        await updateAllRecordsForPhone(phoneNumber);
      }

      return {
        success: false,
        phoneNumber,
        error: sendError.message,
        isLidError: isLidError
      };
    }

  } catch (error) {
    console.error(`❌ Error processing ${participant.first_name}:`, error.message);
    return {
      success: false,
      phoneNumber: participant.mobile,
      error: error.message,
      isLidError: false
    };
  }
}

// Function to send reminders to all pending participants
async function sendToAllPendingParticipants() {
  console.log('\n🚀 Starting marathon reminder delivery...\n');
  console.log('🛡️ Anti-spam measures activated:');
  console.log('   ⏱️  30-45 second delays between messages');
  console.log('   ⚡ 10 second delay for LID errors (non-WhatsApp numbers)');
  console.log('   🎲 Message randomization enabled');
  console.log('   📸 Random image selection enabled');
  console.log('   🔒 Duplicate prevention: One message per unique phone number\n');

  const participants = await fetchParticipants();

  if (participants.length === 0) {
    console.log('❌ No pending participants to process. Exiting...');
    return;
  }

  console.log(`📊 Total unique pending participants: ${participants.length}\n`);
  console.log(`⚠️  Estimated completion time: ~${Math.ceil(participants.length * 37.5 / 60)} minutes\n`);

  const results = {
    total: participants.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    details: []
  };

  // Track sent numbers in this session to prevent duplicates
  const sentNumbers = new Set();

  for (let i = 0; i < participants.length; i++) {
    const participant = participants[i];

    console.log(`\n[${'='.repeat(50)}]`);
    console.log(`[${i + 1}/${participants.length}] Processing ${participant.first_name} ${participant.last_name}`);
    console.log(`[${'='.repeat(50)}]`);

    const result = await sendPendingReminder(participant, sentNumbers);
    results.details.push(result);

    if (result.success) {
      if (result.skipped) {
        results.skipped++;
      } else {
        results.sent++;
      }
    } else {
      results.failed++;
    }

    // Wait random 30-45 seconds between messages (or 10 seconds for LID errors)
    if (i < participants.length - 1) {
      const delay = getRandomDelay(result.isLidError);
      const seconds = (delay / 1000).toFixed(1);

      if (result.isLidError) {
        console.log(`\n⚡ LID Error - Quick wait of ${seconds} seconds...`);
      } else {
        console.log(`\n⏳ Waiting ${seconds} seconds before next message...`);
      }

      console.log(`📊 Progress: ${results.sent} sent, ${results.skipped} skipped, ${results.failed} failed, ${participants.length - i - 1} remaining`);

      // Show countdown (only for longer delays)
      if (delay > 10000) {
        const countdownInterval = 5000;
        for (let remaining = delay; remaining > 0; remaining -= countdownInterval) {
          await new Promise(resolve => setTimeout(resolve, Math.min(countdownInterval, remaining)));
          if (remaining > countdownInterval) {
            process.stdout.write(`⏳ ${(remaining / 1000).toFixed(0)}s... `);
          }
        }
        console.log('✅ Resuming...\n');
      } else {
        await new Promise(resolve => setTimeout(resolve, delay));
        console.log('✅ Resuming...\n');
      }
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 FINAL DELIVERY SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ Successfully sent: ${results.sent}/${results.total}`);
  console.log(`⏭️  Skipped (duplicates): ${results.skipped}/${results.total}`);
  console.log(`❌ Failed: ${results.failed}/${results.total}`);
  console.log(`📈 Success rate: ${(((results.sent + results.skipped)/results.total)*100).toFixed(1)}%`);
  console.log('='.repeat(60) + '\n');

  if (results.failed > 0) {
    console.log('❌ FAILED DELIVERIES:');
    console.log('-'.repeat(60));
    results.details
      .filter(r => !r.success && !r.skipped)
      .forEach((r, idx) => {
        console.log(`   ${idx + 1}. ${r.phoneNumber}: ${r.error}`);
      });
    console.log('-'.repeat(60) + '\n');
  }

  const successRate = (((results.sent + results.skipped) / results.total) * 100).toFixed(1);
  if (successRate >= 90) {
    console.log('🎉 EXCELLENT! High success rate achieved!');
  } else if (successRate >= 70) {
    console.log('✅ GOOD! Acceptable success rate.');
  } else {
    console.log('⚠️  WARNING! Low success rate - check failed deliveries.');
  }
}

// 🔑 QR Authentication
client.on('qr', qr => {
  console.log('\n📱 Scan this QR Code with WhatsApp to authenticate:');
  console.log('='.repeat(50));
  qrcode.generate(qr, { small: true });
  console.log('='.repeat(50) + '\n');
});

client.on('authenticated', () => {
  console.log('✅ WhatsApp Client Authenticated Successfully!');
});

client.on('ready', async () => {
  console.log('\n' + '🎉'.repeat(25));
  console.log('✅ WhatsApp Client is Ready!');
  console.log('🤖 Bot is now ready to send reminder messages');
  console.log('🎉'.repeat(25) + '\n');

  console.log('⏳ Starting in 5 seconds...\n');
  await new Promise(resolve => setTimeout(resolve, 5000));

  await sendToAllPendingParticipants();

  console.log('\n✅ All reminder messages processed!');
  console.log('💡 You can close the browser now.');
  console.log('🙏 Thank you for using the marathon reminder bot!\n');
});

client.on('disconnected', reason => {
  console.log('\n❌ WhatsApp Client Disconnected:', reason);
  console.log('💡 Please restart the bot and scan QR code again.\n');
});

process.on('SIGINT', () => {
  console.log('\n\n⚠️  Bot stopped by user. Exiting gracefully...');
  client.destroy();
  process.exit(0);
});

// 🚀 Initialize WhatsApp Client
console.log('\n' + '='.repeat(60));
console.log('🚀 INITIALIZING WHATSAPP REMINDER BOT');
console.log('='.repeat(60));
console.log('📱 Please scan QR code when prompted...\n');
client.initialize();