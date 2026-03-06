require("dotenv").config();

// ── Startup env check ────────────────────────────────────────────────────────
const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "OPENROUTER_API_KEY"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
}
console.log("✅ All env vars loaded");

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { createClient } = require("@supabase/supabase-js");


/* ================= SUPABASE ================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const supabaseRealtime = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  {
    realtime: { params: { eventsPerSecond: 10 } }
  }
);

/* ================= OPENROUTER ================= */
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = "google/gemini-2.0-flash-001";

/* ================= PROMPTS ================= */
const SYSTEM_PROMPT = `
You are a highly accurate OCR + structured data extraction system.
Rules:
- Extract exactly what is written in the image.
- Do NOT guess missing data.
- If field not present return empty string "".
- Convert all Hindi numbers to English numbers.
- Return ONLY valid raw JSON.
- No markdown.
- No explanation.
`;

const EXTRACTION_PROMPT = `
Extract fields from this Hindi police complaint letter image.
Return ONLY raw JSON:

{
  "addressed_to": "",
  "recipient_address": "",
  "subject": "",
  "date": "",
  "complainant_name": "",
  "complainant_father_name": "",
  "complainant_address": "",
  "complainant_contact": "",
  "accused_name": "",
  "accused_father_name": "",
  "accused_address": "",
  "amount_involved": "",
  "complaint_type": "",
  "complaint_summary": ""
}
`;

/* ================= THANA LIST ================= */
const THANA_LIST = [
  "nevai", "durg", "kanker", "kodekurse", "aamabeda",
  "charama", "korar", "narharpur", "antagarh", "chargaon(siksod)",
  "koylibeda", "raoghat", "tadoki", "pakhanjur", "partapur",
  "badgaon", "bande", "chhote bethiya", "gondahoor",
  "bhanupratappur", "durgkondal", "lohtter", "sarona"
];

/* ================= COMPLAINT CATEGORIES ================= */
const COMPLAINT_CATEGORIES = {
  "1": "मारपीट/धमकी/गालीगलौच",
  "2": "महिला संबंधी/छेड़खानी",
  "3": "भूमि संबंधी",
  "4": "चोरी (बाइक, मोबाइल, व अन्य सामान्य)",
  "5": "सोशल मीडिया संबंधी",
  "6": "ठगी (सामान्य, साइबर)",
  "7": "अवैध शराब/जुआ/सट्टा/गांजा",
  "8": "सामाजिक एवं पारिवारिक विवाद",
  "9": "अन्य (झूठी शिकायत, अपराध में कार्यवाही करवाने, आपसी लेनदेन, धान खरीदी आदि)"
};

/* ================= WHATSAPP ================= */
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: false,
    args: ["--no-sandbox"]
  }
});

/* ================= USER STATE ================= */
const userState = {};

/* ================= GREETING DETECTION ================= */
function isGreeting(msg) {
  const triggers = [
    "hi", "hello", "help", "hey", "helo", "hii", "hiii",
    "नमस्ते", "नमस्कार", "हेल्प", "सहायता", "मदद", "हाय", "हेलो",
    "namaste", "namaskar", "madad", "help me"
  ];
  const lower = msg.toLowerCase().trim();
  return triggers.some(t => lower === t || lower.startsWith(t + " "));
}

/* ================= HELPERS ================= */

function convertHindiDigits(str = "") {
  const hindiNums = "०१२३४५६७८९";
  const engNums = "0123456789";
  return str.replace(/[०-९]/g, d => engNums[hindiNums.indexOf(d)]);
}

function normalizeDate(dateStr = "") {
  if (!dateStr) return null;
  dateStr = convertHindiDigits(dateStr);
  dateStr = dateStr.replace(/[^0-9\/\-\.]/g, "");
  dateStr = dateStr.replace(/[-\.]/g, "/");

  const parts = dateStr.split("/").filter(Boolean);
  if (parts.length !== 3) return null;

  let [day, month, year] = parts;
  if (year.length === 2) year = "20" + year;

  const d = parseInt(day, 10);
  const m = parseInt(month, 10);
  const y = parseInt(year, 10);

  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  if (y < 1900 || y > 2100) return null;

  day   = String(d).padStart(2, "0");
  month = String(m).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function cleanJSON(raw) {
  try {
    let cleaned = raw.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    cleaned = cleaned.trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("JSON Parse Failed:", raw);
    throw new Error("Invalid JSON returned by model");
  }
}

async function urlToBase64(url) {
  const res = await fetch(url);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer).toString("base64");
}

/* ================= WEEKLY COMPLAINT CHECK ================= */
// Returns existing complaint if user registered one within the last 7 days, else null
async function getRecentComplaint(phone) {
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  const { data, error } = await supabase
    .from("complaints")
    .select("id, status, subject, created_at")
    .eq("phone", phone)
    .gte("created_at", oneWeekAgo.toISOString())
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Weekly check error:", error.message);
    return null;
  }

  return data && data.length > 0 ? data[0] : null;
}

/* ================= VISION MODEL ================= */
async function callVisionModel(base64Image) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.0,
      responseformat: { type: "jsonobject" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${base64Image}` }
            },
            { type: "text", text: EXTRACTION_PROMPT }
          ]
        }
      ]
    })
  });

  const data = await response.json();
  if (!data.choices) throw new Error("OpenRouter Error: " + JSON.stringify(data));

  const parsed = cleanJSON(data.choices[0].message.content);
  parsed.date                = normalizeDate(parsed.date);
  parsed.amountinvolved     = convertHindiDigits(parsed.amountinvolved);
  parsed.complainant_contact = convertHindiDigits(parsed.complainant_contact);

  return parsed;
}

/* ================= THANA MATCHING ================= */
async function matchThana(recipientAddress) {
  if (!recipientAddress) return null;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.0,
        responseformat: { type: "jsonobject" },
        messages: [
          {
            role: "system",
            content: `You are a police station name matcher for Kanker district, Chhattisgarh, India.
You receive an address (possibly in Hindi/Devanagari) and a list of thana names in English.
Match the address to the closest thana name using phonetic and semantic similarity.
Rules:
- Return ONLY raw JSON: {"matched_thana": "<exact name from list or null>"}
- Examples: "थाना आमाबेड़ा" → "aamabeda", "थाना नरहरपुर" → "narharpur", "थाना अन्तागढ़" → "antagarh"
- If no confident match, return {"matched_thana": null}
- Only return names that exist EXACTLY in the provided list. No variations.
- No markdown. No explanation.`
          },
          {
            role: "user",
            content: `Address: "${recipientAddress}"
Thana list: ${JSON.stringify(THANA_LIST)}
Which thana does this address refer to?`
          }
        ]
      })
    });

    const data = await response.json();
    if (!data.choices) return null;

    const result = cleanJSON(data.choices[0].message.content);
    console.log(`🏛️ Thana match result:`, result);
    return result.matched_thana || null;

  } catch (err) {
    console.error("Thana match error:", err.message);
    return null;
  }
}

/* ================= COMPLAINT LOG ================= */
async function createComplaintLog(complaintId, submittedBy) {
  const { error } = await supabase
    .from("complaint_logs")
    .insert([{
      complaint_id:   complaintId,
      current_status: "लंबित",
      remarks:        `Complaint submitted via WhatsApp by ${submittedBy || "WHATSAPP_BOT"}`
    }]);

  if (error) {
    console.error("complaint_logs insert error:", error);
  } else {
    console.log(`📋 Log entry created for complaint: ${complaintId}`);
  }
}

/* ================= EXTRACTION FUNCTION ================= */
async function extractLetterData(complaintId, fileUrls, fallbackPhone) {
  try {
    let combinedResult = null;

    for (const url of fileUrls) {
      const base64 = await urlToBase64(url);
      const result = await callVisionModel(base64);

      if (!combinedResult) {
        combinedResult = result;
      } else {
        for (const key in result) {
          if (!combinedResult[key] && result[key]) {
            combinedResult[key] = result[key];
          }
        }
      }
    }

    const accusedDetails = [
      combinedResult.accused_name,
      combinedResult.accused_father_name ? `पिता ${combinedResult.accused_father_name}` : "",
      combinedResult.accused_address
    ].filter(Boolean).join(", ");

    const complainantDetails = [
      combinedResult.complainant_name,
      combinedResult.complainant_father_name ? `पिता ${combinedResult.complainant_father_name}` : "",
      combinedResult.complainant_address,
      combinedResult.complainant_contact
    ].filter(Boolean).join(", ");

    const matchedThana = await matchThana(combinedResult.recipient_address);
    console.log(`🏛️ Allocated thana: ${matchedThana || "no match — keeping default"}`);

    const updatePayload = {
      role_addressed_to:   combinedResult.addressed_to       || "SP",
      recipient_address:   combinedResult.recipient_address   || "",
      subject:             combinedResult.subject             || "",
      date:                combinedResult.date                || null,
      complainant_name:    combinedResult.complainant_name    || "",
      complainant_contact: combinedResult.complainant_contact || fallbackPhone || "",
      complainant_details: complainantDetails                 || "No Description Available",
      accused_details:     accusedDetails                     || "",
      raw_text:            JSON.stringify(combinedResult)
    };

    if (matchedThana) {
      updatePayload.allocated_thana = matchedThana;
    }

    const { error } = await supabase
      .from("complaints")
      .update(updatePayload)
      .eq("id", complaintId);

    if (error) {
      console.error("Supabase update error:", error);
    } else {
      console.log("✅ Extraction completed and row updated for Complaint:", complaintId);
    }

  } catch (err) {
    console.error("Extraction Error:", err.message);
  }
}

/* ================= MENU ================= */
function sendMenu(message) {
  message.reply(
`🚔 महासमुंद पुलिस शिकायत पोर्टल पर आपका स्वागत है

1️⃣ शिकायत दर्ज करे
2️⃣ अतिरिक्त सूचना / जानकारी भेजे

Please choose:
1️⃣ Register Complaint
2️⃣ Send Additional Information / Suchna`
  );
}

/* ================= COMPLAINT CATEGORY MENU ================= */
function sendCategoryMenu(message) {
  message.reply(
`📋 आपकी शिकायत किस प्रकार की है?
What type is your complaint?

1️⃣ मारपीट/धमकी/गालीगलौच
2️⃣ महिला संबंधी/छेड़खानी
3️⃣ भूमि संबंधी
4️⃣ चोरी (बाइक, मोबाइल, व अन्य सामान्य)
5️⃣ सोशल मीडिया संबंधी
6️⃣ ठगी (सामान्य, साइबर)
7️⃣ अवैध शराब/जुआ/सट्टा/गांजा
8️⃣ सामाजिक एवं पारिवारिक विवाद
9️⃣ अन्य (झूठी शिकायत, अपराध में कार्यवाही करवाने, आपसी लेनदेन, धान खरीदी आदि)

कृपया नंबर चुनें | Please choose a number (1-9)`
  );
}

/* ================= GENERATE COMPLAINT ================= */
async function generateComplaint(phone, fromName, message, categoryLabel) {
  try {
    const files = userState[phone]?.files || [];

    const { data, error } = await supabase
      .from("complaints")
      .insert([{
        phone:               phone,
        submitted_by:        fromName,
        complainant_contact: phone,
        file_urls:           files,
        status:              "लंबित",
        source:              "WHATSAPP",
        message:             "Complaint submitted via WhatsApp",
        role_addressed_to:   "SP",
        complainant_name:    "",
        complainant_details: "No Description Available",
        accused_details:     "",
        subject:             categoryLabel || "",
        raw_text:            null,
        date:                null,
        allocated_thana:     "",
        recipient_address:   "",
        updated_at:          new Date().toISOString()
      }])
      .select();

    if (error) {
      console.error(error);
      return message.reply("❌ Database error. Please try again.");
    }

    const complaintId = data[0].id;

    await createComplaintLog(complaintId, fromName);

    await message.reply(
`✅ आपकी शिकायत दर्ज हो गई है।
हम आपकी शिकायत पर कार्यवाही करेंगे।

आपका शिकायत क्रमांक: ${complaintId}
शिकायत की स्थिति जानने के लिए यह नंबर संभाल कर रखें।

Your Complaint Has Been Registered.
We will work on your complaint.

Your Complaint ID: ${complaintId}
Please save this number to track your complaint.

Type MENU to go back.`
    );

    // Run extraction in background only if files were attached
    if (files.length > 0) {
      extractLetterData(complaintId, files, phone);
    }

    userState[phone] = { step: "MENU" };

  } catch (err) {
    console.error(err);
    message.reply("⚠️ सिस्टम में त्रुटि है। कृपया पुनः प्रयास करें।\nSystem error. Please try again.");
  }
}

/* ================= SCHEDULE AUTO SUBMIT ================= */
// After 30s with no image, show category menu instead of auto-submitting
function scheduleAutoCategory(phone, message) {
  if (userState[phone] && userState[phone].categoryTimer) {
    clearTimeout(userState[phone].categoryTimer);
  }

  userState[phone].categoryTimer = setTimeout(async () => {
    if (
      userState[phone] &&
      (userState[phone].step === "WAITINGFORFILE" || userState[phone].step === "CONFIRMING") &&
      (!userState[phone].files || userState[phone].files.length === 0)
    ) {
      console.log(`⏱️ No image received from ${phone} after 30s — showing category menu`);
      userState[phone].step = "WAITINGFORCATEGORY";
      sendCategoryMenu(message);
    }
  }, 30000);
}

// Auto-submit timer (used when files are present)
function scheduleAutoSubmit(phone, fromName, message) {
  if (userState[phone].timer) clearTimeout(userState[phone].timer);

  userState[phone].timer = setTimeout(async () => {
    if (userState[phone] && userState[phone].files && userState[phone].files.length > 0) {
      console.log(`⏱️ Auto-submitting complaint for ${phone} after 30s timeout`);
      const category = userState[phone].category || "";
      await generateComplaint(phone, fromName, message, category);
    }
  }, 30000);
}

/* ================= WHATSAPP EVENTS ================= */

let botReadyTime = null;

client.on("qr", qr => {
  console.log("Scan QR");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  botReadyTime = Date.now();
  console.log("🚔 WhatsApp Bot Ready at", new Date(botReadyTime).toISOString());
  startStatusListener();
});

client.on("message", async message => {
  try {
    if (message.fromMe) return;
    if (message.from.includes("@g.us")) return;

    const msgTimestamp = message.timestamp * 1000;
    if (botReadyTime && msgTimestamp < botReadyTime) {
      console.log(`⏭️ Skipping old message from ${message.from} (sent before bot started)`);
      return;
    }

    const contact = await message.getContact();

    let phone = "";
    if (message.from.endsWith("@c.us")) {
      phone = message.from.replace("@c.us", "").replace(/\D/g, "");
    } else {
      phone = (
        contact.number ||
        contact.id?.user ||
        (contact.id?._serialized || "").replace(/@.*/, "")
      ).replace(/\D/g, "");
    }
    if (!phone) {
      console.warn("Could not resolve phone for:", message.from);
      phone = message.from.replace(/\D/g, "");
    }

    const fromName = contact.pushname || contact.name || contact.number || "Unknown";
    const msg = (message.body || "").trim();
    const msgLower = msg.toLowerCase();

    // Log every incoming message
    await supabase.from("wp_logs").insert([{
      phone:     phone,
      from_name: fromName,
      message:   msg || "MEDIA"
    }]);

    // ── Emergency keywords ────────────────────────────────────────────────────
    const emergencyWords = ["emergency", "help me", "bachao", "बचाओ", "खतरा", "danger", "attack", "मार"];
    if (emergencyWords.some(w => msgLower.includes(w))) {
      return message.reply(
`🚨 आपातकाल | EMERGENCY

तुरंत 112 पर कॉल करें!
Call 112 immediately!`
      );
    }

    // ── Global MENU shortcut ─────────────────────────────────────────────────
    if (msgLower === "menu" || msgLower === "मेनू") {
      // Clear any pending timers
      if (userState[phone]?.timer) clearTimeout(userState[phone].timer);
      if (userState[phone]?.categoryTimer) clearTimeout(userState[phone].categoryTimer);
      userState[phone] = { step: "MENU" };
      return sendMenu(message);
    }

    // ── AWAITING_FEEDBACK state ───────────────────────────────────────────────
    if (userState[phone] && userState[phone].step === "AWAITING_FEEDBACK") {
      const complaintId = userState[phone].complaintId;

      if (msg) {
        // Append new feedback to existing
        const { data: existing } = await supabase
          .from("complaints")
          .select("feedback")
          .eq("id", complaintId)
          .single();

        const prevFeedback = existing?.feedback || "";
        const newFeedback = prevFeedback
          ? `${prevFeedback}\n[${new Date().toLocaleString("hi-IN")}] ${msg}`
          : `[${new Date().toLocaleString("hi-IN")}] ${msg}`;

        const { error } = await supabase
          .from("complaints")
          .update({ feedback: newFeedback })
          .eq("id", complaintId);

        if (error) {
          console.error("Feedback save error:", error);
          return message.reply("प्रतिक्रिया सहेजने में त्रुटि हुई। कृपया पुनः प्रयास करें।");
        }

        console.log(`💬 Feedback saved for complaint ${complaintId}`);
        userState[phone] = { step: "MENU" };
        delete awaitingFeedback[phone];

        return message.reply(
`✅ आपकी सूचना/प्रतिक्रिया सफलतापूर्वक दर्ज हो गई।
Your information has been recorded successfully.

आगे किसी सहायता के लिए MENU लिखें।
Type MENU for further assistance.`
        );
      }
    }

    // ── AWAITING_SUCHNA state (option 2 from main menu) ─────────────────────
    if (userState[phone] && userState[phone].step === "AWAITING_SUCHNA") {
      const complaintId = userState[phone].complaintId;

      if (msg) {
        // Fetch and append to existing feedback
        const { data: existing } = await supabase
          .from("complaints")
          .select("feedback")
          .eq("id", complaintId)
          .single();

        const prevFeedback = existing?.feedback || "";
        const newFeedback = prevFeedback
          ? `${prevFeedback}\n[सूचना - ${new Date().toLocaleString("hi-IN")}] ${msg}`
          : `[सूचना - ${new Date().toLocaleString("hi-IN")}] ${msg}`;

        const { error } = await supabase
          .from("complaints")
          .update({ feedback: newFeedback })
          .eq("id", complaintId);

        if (error) {
          console.error("Suchna save error:", error);
          return message.reply("सूचना सहेजने में त्रुटि हुई। कृपया पुनः प्रयास करें।");
        }

        console.log(`📩 Suchna saved for complaint ${complaintId}`);
        userState[phone] = { step: "MENU" };

        return message.reply(
`✅ आपकी सूचना दर्ज हो गई है।
Your information has been recorded.

संबंधित अधिकारी इस पर ध्यान देंगे।
The concerned officer will look into this.

Type MENU for further assistance.`
        );
      }
    }

    // ── No active session — require greeting ─────────────────────────────────
    if (!userState[phone]) {
      if (isGreeting(msg)) {
        userState[phone] = { step: "MENU" };
        return sendMenu(message);
      } else {
        return;
      }
    }

    // ── MENU state ───────────────────────────────────────────────────────────
    if (userState[phone].step === "MENU") {
      if (msg === "1") {
        // ── Weekly duplicate check ───────────────────────────────────────────
        const recentComplaint = await getRecentComplaint(phone);
        if (recentComplaint) {
          const registeredDate = new Date(recentComplaint.created_at).toLocaleDateString("hi-IN", {
            day: "2-digit", month: "long", year: "numeric"
          });

          userState[phone] = {
            step: "AWAITING_SUCHNA",
            complaintId: recentComplaint.id
          };

          return message.reply(
`ℹ️ आपकी शिकायत पहले से दर्ज है।

शिकायत क्रमांक: ${recentComplaint.id}
दर्ज तिथि: ${registeredDate}
स्थिति: ${recentComplaint.status}

हमने आपकी शिकायत दर्ज कर ली है और उस पर कार्यवाही की जा रही है।
We have already registered your complaint and are working on it.

यदि आप इस शिकायत के बारे में कोई अतिरिक्त जानकारी देना चाहते हैं तो अभी भेजें।
If you want to send any additional information about this complaint, please send it now.

(Type MENU to go back without sending information)`
          );
        }

        // No recent complaint — proceed to file upload
        userState[phone] = { step: "WAITINGFORFILE", files: [] };

        // Start 30s timer — if no image received, show category menu
        scheduleAutoCategory(phone, message);

        return message.reply(
`📋 शिकायत दर्ज करे

कृपया अपनी शिकायत पत्र की फोटो या PDF भेजें।
एक से अधिक पेज हों तो एक-एक करके भेजें।

Register Complaint

Please send photo(s) or PDF of your complaint letter.
Send multiple pages one by one if needed.

(30 सेकंड में कोई फोटो न मिली तो शिकायत का प्रकार चुनने का विकल्प दिया जाएगा)
(If no photo is received in 30 seconds, you will be asked to choose complaint type)

Type MENU to cancel.`
        );
      }

      if (msg === "2") {
        // Option 2 — send suchna / additional information
        userState[phone] = { step: "ASKING_SUCHNA_ID" };
        return message.reply(
`📝 अतिरिक्त सूचना भेजे | Send Additional Information

कृपया अपना शिकायत क्रमांक भेजें।
Please send your Complaint ID number.

उदाहरण | Example: 42

Type MENU to cancel.`
        );
      }

      if (isGreeting(msg)) {
        return sendMenu(message);
      }

      return message.reply(
`कृपया 1 या 2 चुनें।
Please type 1 or 2 to continue.

1️⃣ शिकायत दर्ज करे | Register Complaint
2️⃣ अतिरिक्त सूचना भेजे | Send Additional Information`
      );
    }

    // ── ASKING_SUCHNA_ID state ───────────────────────────────────────────────
    if (userState[phone].step === "ASKING_SUCHNA_ID") {
      const complaintId = parseInt(msg.replace(/\D/g, ""), 10);

      if (!complaintId) {
        return message.reply(
`⚠️ कृपया सिर्फ शिकायत क्रमांक (number) भेजें।
Please send only the complaint ID number.

उदाहरण | Example: 42`
        );
      }

      // Verify complaint exists and belongs to this phone
      const { data, error } = await supabase
        .from("complaints")
        .select("id, phone, status")
        .eq("id", complaintId)
        .single();

      if (error || !data) {
        return message.reply(
`❌ शिकायत क्रमांक ${complaintId} नहीं मिला।
Complaint ID ${complaintId} not found.

कृपया सही क्रमांक दर्ज करें।
Please check and try again.

Type MENU to go back.`
        );
      }

      userState[phone] = { step: "AWAITING_SUCHNA", complaintId };

      return message.reply(
`✅ शिकायत क्रमांक ${complaintId} मिली।

कृपया अपनी अतिरिक्त सूचना / जानकारी यहाँ लिखें या भेजें।
Please type or send your additional information now.

(Type MENU to cancel)`
      );
    }

    // ── WAITING FOR CATEGORY ─────────────────────────────────────────────────
    if (userState[phone].step === "WAITINGFORCATEGORY") {
      // Check if user sends an image even at this stage — accept it
      if (message.hasMedia) {
        clearTimeout(userState[phone].categoryTimer);
        // Move to file handling
        userState[phone].step = "WAITINGFORFILE";
        if (!userState[phone].files) userState[phone].files = [];
        // Fall through to WAITINGFORFILE handling below by re-triggering
        // We handle media directly here:
        const media = await message.downloadMedia();
        const fileExt = media.mimetype.split("/")[1];
        const fileName = `${phone}_${Date.now()}.${fileExt}`;
        const buffer = Buffer.from(media.data, "base64");

        const { error } = await supabase.storage
          .from("complaint-files")
          .upload(fileName, buffer, { contentType: media.mimetype });

        if (error) {
          console.error(error);
          return message.reply(
`❌ फाइल अपलोड नहीं हो सकी। कृपया दोबारा भेजें।
File upload failed. Please try again.`
          );
        }

        const { data: publicUrlData } = supabase.storage
          .from("complaint-files")
          .getPublicUrl(fileName);

        userState[phone].files.push(publicUrlData.publicUrl);
        userState[phone].step = "CONFIRMING";

        scheduleAutoSubmit(phone, fromName, message);

        const fileCount = userState[phone].files.length;
        return message.reply(
`✅ फोटो मिल गई! (${fileCount} page${fileCount > 1 ? "s" : ""} received)

क्या आपके द्वारा सम्पूर्ण शिकायत भेज दी गई है?
Have you sent all pages of your complaint?

Reply YES / NO
(30 सेकंड बाद स्वतः दर्ज हो जाएगी | Auto-submits in 30 seconds)`
        );
      }

      // Text input — expect category number 1-9
      const choice = msg.trim();
      if (!COMPLAINT_CATEGORIES[choice]) {
        return message.reply(
`⚠️ कृपया 1 से 9 के बीच कोई नंबर चुनें।
Please choose a number between 1 and 9.

${Object.entries(COMPLAINT_CATEGORIES).map(([k, v]) => `${k}️⃣ ${v}`).join("\n")}`
        );
      }

      const categoryLabel = COMPLAINT_CATEGORIES[choice];
      userState[phone].category = categoryLabel;

      // Register complaint without files
      await generateComplaint(phone, fromName, message, categoryLabel);
      return;
    }

    // ── WAITING FOR FILE ─────────────────────────────────────────────────────
    if (userState[phone].step === "WAITINGFORFILE") {
      if (!message.hasMedia) {
        return message.reply(
`📸 कृपया शिकायत पत्र की फोटो या PDF भेजें।
Please send a photo or PDF of your complaint letter.

Type MENU to cancel.`
        );
      }

      // Cancel category timer since we got a file
      if (userState[phone].categoryTimer) clearTimeout(userState[phone].categoryTimer);

      const media = await message.downloadMedia();
      const fileExt = media.mimetype.split("/")[1];
      const fileName = `${phone}_${Date.now()}.${fileExt}`;
      const buffer = Buffer.from(media.data, "base64");

      const { error } = await supabase.storage
        .from("complaint-files")
        .upload(fileName, buffer, { contentType: media.mimetype });

      if (error) {
        console.error(error);
        return message.reply(
`❌ फाइल अपलोड नहीं हो सकी। कृपया दोबारा भेजें।
File upload failed. Please try again.`
        );
      }

      const { data: publicUrlData } = supabase.storage
        .from("complaint-files")
        .getPublicUrl(fileName);

      userState[phone].files.push(publicUrlData.publicUrl);
      userState[phone].step = "CONFIRMING";

      scheduleAutoSubmit(phone, fromName, message);

      const fileCount = userState[phone].files.length;
      return message.reply(
`✅ फोटो मिल गई! (${fileCount} page${fileCount > 1 ? "s" : ""} received)

क्या आपके द्वारा सम्पूर्ण शिकायत भेज दी गई है?
Have you sent all pages of your complaint?

Reply YES / NO
(30 सेकंड बाद स्वतः दर्ज हो जाएगी | Auto-submits in 30 seconds)`
      );
    }

    // ── CONFIRMING state ─────────────────────────────────────────────────────
    if (userState[phone].step === "CONFIRMING") {

      if (msgLower === "yes" || msgLower === "हाँ" || msgLower === "han" || msgLower === "ha") {
        clearTimeout(userState[phone].timer);
        const category = userState[phone].category || "";
        return await generateComplaint(phone, fromName, message, category);
      }

      if (msgLower === "no" || msgLower === "नहीं" || msgLower === "nahi") {
        clearTimeout(userState[phone].timer);
        userState[phone].step = "WAITINGFORFILE";
        return message.reply(
`ठीक है! बाकी पेज की फोटो भेजें।
Okay! Please send the remaining pages.`
        );
      }

      // Another image while confirming — accept it
      if (message.hasMedia) {
        clearTimeout(userState[phone].timer);

        const media = await message.downloadMedia();
        const fileExt = media.mimetype.split("/")[1];
        const fileName = `${phone}_${Date.now()}.${fileExt}`;
        const buffer = Buffer.from(media.data, "base64");

        const { error } = await supabase.storage
          .from("complaint-files")
          .upload(fileName, buffer, { contentType: media.mimetype });

        if (error) {
          console.error(error);
          return message.reply(
`❌ फाइल अपलोड नहीं हो सकी। कृपया दोबारा भेजें।
File upload failed. Please try again.`
          );
        }

        const { data: publicUrlData } = supabase.storage
          .from("complaint-files")
          .getPublicUrl(fileName);

        userState[phone].files.push(publicUrlData.publicUrl);

        scheduleAutoSubmit(phone, fromName, message);

        const fileCount = userState[phone].files.length;
        return message.reply(
`✅ फोटो मिल गई! (${fileCount} page${fileCount > 1 ? "s" : ""} received)

क्या आपके द्वारा सम्पूर्ण शिकायत भेज दी गई है?
Have you sent all pages of your complaint?

Reply YES / NO
(30 सेकंड बाद स्वतः दर्ज हो जाएगी | Auto-submits in 30 seconds)`
        );
      }

      return message.reply(
`कृपया YES या NO में जवाब दें।
Please reply with YES or NO.

YES — शिकायत दर्ज करें | Submit
NO — और फोटो भेजनी हैं | Send more pages`
      );
    }

    // ── Catch-all ────────────────────────────────────────────────────────────
    userState[phone] = { step: "MENU" };
    return sendMenu(message);

  } catch (err) {
    console.error(err);
    message.reply("⚠️ सिस्टम में त्रुटि है। कृपया पुनः प्रयास करें।\nSystem error. Please try again.");
  }
});


/* ================= STATUS CHANGE MESSAGES ================= */

const STATUS_MESSAGES = {
  "अपराध":          "शिकायत के आधार पर अपराध कायम किया गया है",
  "फैना":           "शिकायत पुलिस हस्तक्षेप अयोग्य पाए जाने पर फैना दिया गया है",
  "अप्रमाणित":     "आपकी शिकायत अप्रमाणित पायी गयी है",
  "प्रतिबंधात्मक": "आपके शिकायत के आधार पर अनावेदक के खिलाफ प्रतिबंधात्मक कार्यवाही की गयी है",
  "वापसी":          "आपके द्वारा शिकायत वापिस लिया गया है"
};

const notifiedComplaints = new Set();
const awaitingFeedback = {};

async function sendResolutionMessage(phone, complaintId, status) {
  const statusMsg = STATUS_MESSAGES[status];
  if (!statusMsg) return;

  const chatId = phone.replace(/\D/g, "") + "@c.us";

  try {
    await client.sendMessage(chatId,
`आपके द्वारा दी गई शिकायत ${complaintId} का निराकरण किया गया है

${statusMsg}`
    );

    setTimeout(async () => {
      await client.sendMessage(chatId,
`यदि आप शिकायत निराकरण से संतुष्ट नहीं है तो अपनी प्रतिक्रिया साँझा करे`
      );

      awaitingFeedback[phone] = complaintId;
      userState[phone] = { step: "AWAITING_FEEDBACK", complaintId };

    }, 3000);

  } catch (err) {
    console.error("Failed to send resolution message to", phone, err.message);
  }
}

const lastKnownStatus = {};

async function handleStatusChange(complaintId, phone, oldStatus, newStatus) {
  if (!STATUS_MESSAGES[newStatus]) return;
  if (!phone) {
    console.warn("No phone for complaint:", complaintId);
    return;
  }

  const key = `${complaintId}:${newStatus}`;
  if (notifiedComplaints.has(key)) return;
  notifiedComplaints.add(key);

  console.log(`📣 Status changed for complaint ${complaintId}: ${oldStatus} → ${newStatus}`);

  setTimeout(() => {
    sendResolutionMessage(phone, complaintId, newStatus);
  }, 60000);
}

async function seedInitialStatuses() {
  try {
    const { data, error } = await supabase
      .from("complaints")
      .select("id, phone, status")
      .not("phone", "is", null);

    if (error) { console.error("Seed error:", error.message); return; }

    for (const row of (data || [])) {
      lastKnownStatus[row.id] = row.status;
      if (row.status !== "लंबित" && STATUS_MESSAGES[row.status]) {
        notifiedComplaints.add(`${row.id}:${row.status}`);
      }
    }
    console.log(`🌱 Seeded ${Object.keys(lastKnownStatus).length} complaints into status cache`);
  } catch (err) {
    console.error("Seed exception:", err.message);
  }
}

async function startStatusListener() {
  await seedInitialStatuses();

  supabaseRealtime
    .channel("complaints-status-watch")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "complaints" },
      async (payload) => {
        const newRow = payload.new;
        const oldRow = payload.old;

        if (!newRow.status || newRow.status === (oldRow.status || "")) return;
        if (newRow.status === "लंबित") return;

        lastKnownStatus[newRow.id] = newRow.status;

        await handleStatusChange(newRow.id, newRow.phone, oldRow.status, newRow.status);
      }
    )
    .subscribe((status) => {
      console.log("📡 Realtime subscription status:", status);
    });

  setInterval(async () => {
    try {
      const { data, error } = await supabase
        .from("complaints")
        .select("id, phone, status")
        .not("phone", "is", null);

      if (error) { console.error("Poll error:", error.message); return; }

      for (const row of (data || [])) {
        const prev = lastKnownStatus[row.id];
        const curr = row.status;

        if (prev !== undefined && prev !== curr && curr !== "लंबित") {
          await handleStatusChange(row.id, row.phone, prev, curr);
        }

        lastKnownStatus[row.id] = curr;
      }
    } catch (err) {
      console.error("Poll exception:", err.message);
    }
  }, 20000);

  console.log("👀 Status listener started (Realtime + 20s polling)");
}

/* ================= START ================= */
client.initialize();