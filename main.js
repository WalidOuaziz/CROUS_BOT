const express = require("express");
const axios = require("axios");
const nodemailer = require("nodemailer");
const cheerio = require("cheerio");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration email
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Variables pour stocker les logements et leur historique
let logementsActuels = new Map();
let derniereNotification = new Map();

const INTERVALLE_RENOTIFICATION =
  parseInt(process.env.RENOTIFICATION_INTERVAL) || 15000;

// URL CROUS
const CROUS_URL =
  "https://trouverunlogement.lescrous.fr/tools/41/search?bounds=6.7872143_47.6713057_6.8948707_47.6203259";

function getVilleFromUrl(url) {
  const bounds = url.match(/bounds=([\d.,_-]+)/);
  if (!bounds) return "Zone inconnue";

  const coords = bounds[1].split("_");
  if (coords.length >= 4) {
    const lat = parseFloat(coords[1]);
    const lon = parseFloat(coords[0]);

    if (lat >= 48.5 && lat <= 49.0 && lon >= 2.0 && lon <= 2.5) return "Paris/Île-de-France";
    if (lat >= 43.2 && lat <= 43.7 && lon >= 5.2 && lon <= 5.6) return "Aix-en-Provence/Marseille";
    if (lat >= 45.6 && lat <= 45.9 && lon >= 4.7 && lon <= 5.1) return "Lyon";
    if (lat >= 43.5 && lat <= 43.7 && lon >= 1.3 && lon <= 1.5) return "Toulouse";
    if (lat >= 47.1 && lat <= 47.3 && lon >= -1.7 && lon <= -1.4) return "Nantes";
    if (lat >= 44.8 && lat <= 45.0 && lon >= -0.7 && lon <= -0.4) return "Bordeaux";
  }

  return `Coordonnées: ${coords[1]},${coords[0]}`;
}

const ZONE_SURVEILLEE = getVilleFromUrl(CROUS_URL);

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
};

async function envoyerTelegram(message) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      console.log("⚠️ Telegram non configuré correctement.");
      return;
    }
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
    });
    console.log("✅ Notification Telegram envoyée");
  } catch (error) {
    console.error("❌ Erreur envoi Telegram:", error.message);
  }
}

async function envoyerNotification(logement) {
  try {
    const estNouveau = logement.typeNotification === "NOUVEAU";
    const estRappel = logement.typeNotification === "RAPPEL";

    const subject = estNouveau
      ? `🆕 NOUVEAU logement CROUS: ${logement.titre}`
      : `🔔 RAPPEL logement CROUS: ${logement.titre}`;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: "ouazizwalid.student@gmail.com",
      subject,
      html: `<h2>${estNouveau ? "🎉 Nouveau logement disponible" : "🔔 Rappel"} dans ${ZONE_SURVEILLEE} !</h2>
      <p>🏠 ${logement.titre}</p>
      <p>📍 ${logement.adresse}</p>
      <p>💰 ${logement.prix}</p>
      <p>📐 ${logement.surface}</p>
      <p>🏷️ ${logement.type}</p>
      <p>🔧 ${logement.equipements}</p>
      <p><a href="${logement.lien}">Voir sur le site CROUS</a></p>`
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ Email ${estNouveau ? "nouveau" : "rappel"} envoyé pour: ${logement.titre}`);
  } catch (error) {
    console.error("❌ Erreur envoi email:", error.message);
  }
}

async function checkLogements() {
  try {
    console.log(`[${new Date().toLocaleString()}] Vérification des logements...`);
    const response = await axios.get(CROUS_URL, { headers, timeout: 10000 });
    const $ = cheerio.load(response.data);

    const logementsDetectes = new Map();
    $(".fr-grid-row.fr-grid-row--gutters li.fr-col-12").each((index, element) => {
      const $elem = $(element);
      const card = $elem.find(".fr-card");
      if (card.length === 0) return;

      const titre = $elem.find(".fr-card__title a").text().trim();
      const adresse = $elem.find(".fr-card__desc").text().trim();
      const prix = $elem.find(".fr-badge").first().text().trim();
      const lienLogement = $elem.find(".fr-card__title a").attr("href");

      const details = [];
      $elem.find(".fr-card__detail").each((i, detail) => {
        const detailText = $(detail).text().trim();
        if (detailText) details.push(detailText);
      });

      const id = `${titre}_${adresse}`.replace(/\s+/g, "_").replace(/[^\w_àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/gi, "");

      logementsDetectes.set(id, {
        id,
        titre,
        adresse,
        prix,
        details: details.join(" | "),
        lien: lienLogement ? `https://trouverunlogement.lescrous.fr${lienLogement}` : CROUS_URL,
        surface: details.find((d) => d.includes("m²")) || "Surface non spécifiée",
        type: details.find((d) => d.includes("Individuel") || d.includes("Collectif")) || "Type non spécifié",
        equipements: details.find((d) => d.includes("WC") || d.includes("Douche") || d.includes("Frigo")) || "Équipements voir détail",
        derniereSeen: new Date(),
      });
    });

    const maintenant = new Date();
    const logementsANotifier = [];

    for (const [id, logement] of logementsDetectes) {
      const estNouveau = !logementsActuels.has(id);
      const derniereNotif = derniereNotification.get(id);
      const doitRenotifier = !derniereNotif || maintenant - derniereNotif >= INTERVALLE_RENOTIFICATION;

      if (estNouveau) {
        logementsANotifier.push({ ...logement, typeNotification: "NOUVEAU" });
      } else if (doitRenotifier) {
        logementsANotifier.push({ ...logement, typeNotification: "RAPPEL", tempsEcoule: Math.round((maintenant - derniereNotif) / 60000) });
      }
    }

    logementsActuels = new Map(logementsDetectes);

    for (const logement of logementsANotifier) {
      await envoyerNotification(logement);
      const telegramMessage = `
${logement.typeNotification === "NOUVEAU" ? '🆕 NOUVEAU LOGEMENT CROUS' : '🔔 RAPPEL LOGEMENT CROUS'}
🏠 ${logement.titre}
📍 ${logement.adresse}
💰 ${logement.prix}
📐 ${logement.surface}
🏷️ ${logement.type}
🔧 ${logement.equipements}
🔗 ${logement.lien}`;
      await envoyerTelegram(telegramMessage);
      derniereNotification.set(logement.id, maintenant);
    }

  } catch (error) {
    console.error("❌ Erreur lors de la vérification:", error.message);
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "Bot CROUS actif",
    zone: ZONE_SURVEILLEE,
    url_surveillance: CROUS_URL,
    logements_actuels: logementsActuels.size,
    derniere_verification: new Date().toLocaleString(),
  });
});

app.listen(PORT, async () => {
  console.log(`🚀 Bot CROUS démarré sur le port ${PORT}`);
  await checkLogements();
  setInterval(checkLogements, 5000);
});
