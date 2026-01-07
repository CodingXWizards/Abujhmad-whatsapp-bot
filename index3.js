const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');

// 🔑 Supabase credentials
const SUPABASE_URL = "https://vknemthgkkbseucxgmyc.supabase.co";
const SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZrbmVtdGhna2tic2V1Y3hnbXljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTMzNTM1OTgsImV4cCI6MjA2ODkyOTU5OH0.HWOJ8ZkkCZLXWbR9x6fNDigEKfTmnmCmVhSOAruN7N0";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

// 📋 Fetch participants from Supabase using the exact query
async function fetchParticipants() {
  try {
    console.log('📥 Fetching participants from database...');

    const { data, error } = await supabase
      .schema('marathon')
      .from('registrations_2026')
      .select(`
        mobile,
        city,
        first_name,
        last_name,
        t_shirt_size,
        bib_num,
        payment_shirt,
        payment_status,
        Date_change_msg
      `)
      .in('payment_status', ['DONE', 'OFFLINE'])
      .or('Date_change_msg.is.null,Date_change_msg.eq.false');

    if (error) {
      console.error('❌ Error fetching participants:', error);
      throw error;
    }

    if (!data || data.length === 0) {
      console.log('⚠️ No pending participants found');
      return [];
    }

    // Remove duplicates based on mobile number
    const uniqueParticipants = Array.from(
      new Map(data.map(item => [item.mobile, item])).values()
    );

    console.log(`✅ Found ${uniqueParticipants.length} unique participants pending date change message`);
    return uniqueParticipants;

  } catch (error) {
    console.error('❌ Database error:', error);
    return [];
  }
}

// Helper function to generate random delay (30-45 seconds)
function getRandomDelay() {
  const min = 30000; // 30 seconds
  const max = 45000; // 45 seconds
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Helper function to generate short delay for failed numbers (3-5 seconds)
function getShortDelay() {
  const min = 3000; // 3 seconds
  const max = 5000; // 5 seconds
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Helper function to add slight variations to message
function randomizeMessage(baseMessage) {
  const variations = [
    baseMessage,
    baseMessage.replace('आवश्यक सूचना', 'महत्वपूर्ण सूचना'),
    baseMessage.replace('खेद है।', 'खेद है।'),
    baseMessage.replace('आपका registration', 'आपकी registration')
  ];
  
  return variations[Math.floor(Math.random() * variations.length)];
}

// Helper function to check if error is number doesn't exist
function isNumberNotExistError(errorMessage) {
  const notExistPatterns = [
    'No LID for user',
    'phone number is not registered',
    'number does not exist',
    'is not a WhatsApp user',
    'not registered on WhatsApp'
  ];
  
  return notExistPatterns.some(pattern => 
    errorMessage.toLowerCase().includes(pattern.toLowerCase())
  );
}

// Function to send date change message to one participant
async function sendDateChangeMessage(participant) {
  try {
    const { 
      mobile: phoneNumber,
      first_name: firstName,
      last_name: lastName
    } = participant;

    console.log(`\n📤 Processing: ${firstName} ${lastName} (${phoneNumber})`);

    // Validate phone number
    if (!phoneNumber) {
      console.log(`❌ No phone number for ${firstName} ${lastName}`);
      return {
        success: false,
        phoneNumber: 'N/A',
        error: 'No phone number',
        numberNotExist: false
      };
    }

    // Format phone number
    let formattedNumber = phoneNumber.replace(/\D/g, '');
    if (!formattedNumber.startsWith('91') && formattedNumber.length === 10) {
      formattedNumber = '91' + formattedNumber;
    }
    const chatId = `${formattedNumber}@c.us`;

    // Construct base message
    const baseMessage = `*आवश्यक सूचना* 🚨

📢 *नई तिथियाँ घोषित!*

🏃‍♂️ *अबूझमाड़ पीस हाफ मैराथन 2026*
*(5वाँ संस्करण)*

🏃‍♀️ मैराथन दौड़ की *नई तिथि*
📅 *31 जनवरी 2026*

📍 नारायणपुर, छत्तीसगढ़
🕊️ शांति • एकता • खेल भावना

📲 *पंजीकरण जारी है!*
🔗 https://runabhujhmad.in/registration

🙏 किसी भी प्रकार की समस्या के लिए हमें खेद है।
आपका registration सफल रहा है।

📧 कृपया अपनी समस्या हमें ईमेल करें:
support@runabhujhmad.in`;

    // Randomize message slightly
    const message = randomizeMessage(baseMessage);

    // Send message
    try {
      const response = await client.sendMessage(chatId, message);
      console.log(`✅ Message sent to ${firstName} ${lastName} (${phoneNumber})`);

      // Update Date_change_msg to true (boolean)
      const { error: updateError } = await supabase
        .schema('marathon')
        .from('registrations_2026')
        .update({ Date_change_msg: true })
        .eq('mobile', phoneNumber);

      if (updateError) {
        console.error('⚠️ Error updating Date_change_msg:', updateError);
      } else {
        console.log(`✅ Updated Date_change_msg to TRUE for ${firstName} ${lastName}`);
      }

      // Log success to marathon_messages
      await supabase
        .from('marathon_messages')
        .insert([{
          phone_number: phoneNumber,
          first_name: firstName,
          last_name: lastName,
          message_id: response.id._serialized,
          status: 'sent',
          sent_at: new Date().toISOString(),
          message_type: 'date_change'
        }]);

      return {
        success: true,
        phoneNumber,
        messageId: response.id._serialized,
        numberNotExist: false
      };

    } catch (sendError) {
      const errorMsg = sendError.message || String(sendError);
      const numberNotExist = isNumberNotExistError(errorMsg);
      
      console.log(`❌ Failed for ${phoneNumber}:`, errorMsg);
      
      if (numberNotExist) {
        console.log(`🚫 Number does not exist on WhatsApp - marking Date_change_msg as FALSE`);
        
        // Update Date_change_msg to false for non-existent numbers
        const { error: updateError } = await supabase
          .schema('marathon')
          .from('registrations_2026')
          .update({ Date_change_msg: false })
          .eq('mobile', phoneNumber);

        if (updateError) {
          console.error('⚠️ Error updating Date_change_msg:', updateError);
        } else {
          console.log(`✅ Marked Date_change_msg as FALSE for ${firstName} ${lastName}`);
        }
      }
      
      // Log failed attempt
      await supabase
        .from('marathon_messages')
        .insert([{
          phone_number: phoneNumber,
          first_name: firstName,
          last_name: lastName,
          status: numberNotExist ? 'not_exist' : 'failed',
          error_message: errorMsg,
          sent_at: new Date().toISOString(),
          message_type: 'date_change'
        }]);

      return {
        success: false,
        phoneNumber,
        error: errorMsg,
        numberNotExist: numberNotExist
      };
    }

  } catch (error) {
    console.error(`❌ Error processing ${participant.first_name}:`, error.message);
    return {
      success: false,
      phoneNumber: participant.mobile,
      error: error.message,
      numberNotExist: false
    };
  }
}

// Function to send messages to all participants
async function sendToAllParticipants() {
  console.log('\n🚀 Starting date change message delivery...\n');
  console.log('🛡️ Anti-spam measures activated:');
  console.log('   ⏱️  30-45 second delays between successful messages');
  console.log('   ⚡ 3-5 second delays for non-existent numbers');
  console.log('   🎲 Message randomization enabled');
  console.log('   ✅ Skipping already sent messages (Date_change_msg = true)\n');

  const participants = await fetchParticipants();

  if (participants.length === 0) {
    console.log('❌ No pending participants to process. Exiting...');
    return;
  }

  console.log(`📊 Total pending participants: ${participants.length}\n`);
  console.log(`⚠️  Estimated completion time: ~${Math.ceil(participants.length * 37.5 / 60)} minutes\n`);

  const results = {
    total: participants.length,
    sent: 0,
    failed: 0,
    notExist: 0,
    details: []
  };

  for (let i = 0; i < participants.length; i++) {
    const participant = participants[i];
    
    console.log(`\n[${'='.repeat(50)}]`);
    console.log(`[${i + 1}/${participants.length}] Processing ${participant.first_name} ${participant.last_name}`);
    console.log(`[${'='.repeat(50)}]`);
    
    const result = await sendDateChangeMessage(participant);
    results.details.push(result);

    if (result.success) {
      results.sent++;
    } else if (result.numberNotExist) {
      results.notExist++;
    } else {
      results.failed++;
    }

    // Wait between messages - MUCH shorter wait for non-existent numbers
    if (i < participants.length - 1) {
      let delay;
      
      if (result.numberNotExist) {
        delay = getShortDelay();
        const seconds = (delay / 1000).toFixed(1);
        console.log(`\n⚡ Number not found - waiting only ${seconds} seconds before next...`);
      } else {
        delay = getRandomDelay();
        const seconds = (delay / 1000).toFixed(1);
        console.log(`\n⏳ Waiting ${seconds} seconds before next message...`);
      }
      
      console.log(`📊 Progress: ${results.sent} sent, ${results.notExist} not exist, ${results.failed} failed, ${participants.length - i - 1} remaining`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      console.log('✅ Resuming...\n');
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 FINAL DELIVERY SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ Successfully sent: ${results.sent}/${results.total} (${((results.sent/results.total)*100).toFixed(1)}%)`);
  console.log(`🚫 Numbers not found: ${results.notExist}/${results.total} (${((results.notExist/results.total)*100).toFixed(1)}%)`);
  console.log(`❌ Failed: ${results.failed}/${results.total} (${((results.failed/results.total)*100).toFixed(1)}%)`);
  console.log('='.repeat(60) + '\n');

  if (results.notExist > 0) {
    console.log('🚫 NON-EXISTENT NUMBERS (Date_change_msg = FALSE):');
    console.log('-'.repeat(60));
    results.details
      .filter(r => r.numberNotExist)
      .forEach((r, idx) => {
        console.log(`   ${idx + 1}. ${r.phoneNumber}`);
      });
    console.log('-'.repeat(60) + '\n');
  }

  if (results.failed > 0) {
    console.log('❌ FAILED DELIVERIES (other errors):');
    console.log('-'.repeat(60));
    results.details
      .filter(r => !r.success && !r.numberNotExist)
      .forEach((r, idx) => {
        console.log(`   ${idx + 1}. ${r.phoneNumber}: ${r.error}`);
      });
    console.log('-'.repeat(60) + '\n');
  }

  const successRate = ((results.sent / results.total) * 100).toFixed(1);
  if (successRate >= 90) {
    console.log('🎉 EXCELLENT! High success rate achieved!');
  } else if (successRate >= 70) {
    console.log('✅ GOOD! Acceptable success rate.');
  } else {
    console.log('⚠️  WARNING! Low success rate - check failed deliveries.');
  }
}

// Event handlers
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
  console.log('🤖 Bot is now ready to send date change messages');
  console.log('🎉'.repeat(25) + '\n');

  console.log('⏳ Starting in 5 seconds...\n');
  await new Promise(resolve => setTimeout(resolve, 5000));

  await sendToAllParticipants();

  console.log('\n✅ All messages processed successfully!');
  console.log('💡 You can close the browser now.');
  console.log('🙏 Thank you for using the marathon bot!\n');
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

// 🚀 Initialize
console.log('\n' + '='.repeat(60));
console.log('🚀 INITIALIZING DATE CHANGE MESSAGE BOT');
console.log('='.repeat(60));
console.log('📱 Please scan QR code when prompted...\n');
client.initialize();