const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const cheerio = require('cheerio');


require('dotenv').config();


const app = express();
const PORT = process.env.PORT || 3000;









// Configuration email
const transporter = nodemailer.createTransport({
  service: 'gmail', // ou votre service préféré
  auth: {
    user: process.env.EMAIL_USER, // votre email
    pass: process.env.EMAIL_PASS  // mot de passe ou app password
  }
});

// Variables pour stocker les logements et leur historique
let logementsActuels = new Map(); // Logements actuellement disponibles
let derniereNotification = new Map(); // Dernière fois qu'on a envoyé un email pour chaque logement

// Intervalle pour renvoyer les notifications (en millisecondes)
const INTERVALLE_RENOTIFICATION = parseInt(process.env.RENOTIFICATION_INTERVAL) || 60000; // 5 minutes par défaut

// URL CROUS - MODIFIEZ CETTE URL selon votre zone souhaitée
// Exemples d'URLs par ville :
// Aix-en-Provence: https://trouverunlogement.lescrous.fr/tools/41/search?bounds=5.2694745_43.6259224_5.5063013_43.4461058
// Marseille: https://trouverunlogement.lescrous.fr/tools/41/search?bounds=5.2694745_43.6259224_5.5063013_43.4461058
// Paris: https://trouverunlogement.lescrous.fr/tools/41/search?bounds=2.1695755_48.7188772_2.209699_48.6755091
// Lyon: https://trouverunlogement.lescrous.fr/tools/41/search?bounds=4.7573_45.6479_5.0919_45.8566
const CROUS_URL = 'https://trouverunlogement.lescrous.fr/tools/41/search?bounds=6.7872143_47.6713057_6.8948707_47.6203259'

// Extraire le nom de la ville à partir de l'URL pour l'affichage
function getVilleFromUrl(url) {
  const bounds = url.match(/bounds=([\d.,_-]+)/);
  if (!bounds) return 'Zone inconnue';
  
  const coords = bounds[1].split('_');
  if (coords.length >= 4) {
    const lat = parseFloat(coords[1]);
    const lon = parseFloat(coords[0]);
    
    // Déterminer la ville approximative selon les coordonnées
    if (lat >= 48.5 && lat <= 49.0 && lon >= 2.0 && lon <= 2.5) return 'Paris/Île-de-France';
    if (lat >= 43.2 && lat <= 43.7 && lon >= 5.2 && lon <= 5.6) return 'Aix-en-Provence/Marseille';
    if (lat >= 45.6 && lat <= 45.9 && lon >= 4.7 && lon <= 5.1) return 'Lyon';
    if (lat >= 43.5 && lat <= 43.7 && lon >= 1.3 && lon <= 1.5) return 'Toulouse';
    if (lat >= 47.1 && lat <= 47.3 && lon >= -1.7 && lon <= -1.4) return 'Nantes';
    if (lat >= 44.8 && lat <= 45.0 && lon >= -0.7 && lon <= -0.4) return 'Bordeaux';
  }
  
  return `Coordonnées: ${coords[1]},${coords[0]}`;
}

const ZONE_SURVEILLEE = getVilleFromUrl(CROUS_URL);

// Configuration headers pour simuler un navigateur
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};



// Fonction pour vérifier la disponibilité des logements
async function checkLogements() {
  try {
    console.log(`[${new Date().toLocaleString()}] Vérification des logements disponibles...`);
    
    const response = await axios.get(CROUS_URL, { 
      headers,
      timeout: 10000,
      validateStatus: function (status) {
        return status < 500; // Accepte les codes de statut < 500
      }
    });

    if (response.status !== 200) {
      console.log(`Erreur HTTP: ${response.status}`);
      return;
    }

    const $ = cheerio.load(response.data);
    const logementsDetectes = new Map(); // Logements trouvés lors de cette vérification

    // Debug: afficher des informations sur la page récupérée
    console.log(`📄 Taille de la réponse: ${response.data.length} caractères`);

    // Vérifier d'abord s'il y a le message "Aucun logement trouvé"
    const noResultsMessage = $('.SearchResults-desktop, .fr-h4').text().trim();
    console.log(`🔍 Message de résultat: "${noResultsMessage}"`);
    
    if (noResultsMessage.includes('Aucun logement trouvé')) {
      console.log('ℹ️  Aucun logement disponible (message officiel du site)');
      
      // Nettoyer les logements qui ne sont plus disponibles
      if (logementsActuels.size > 0) {
        console.log(`🧹 Nettoyage: ${logementsActuels.size} logement(s) ne sont plus disponibles`);
        logementsActuels.clear();
        derniereNotification.clear();
      }
      return;
    }

    // Parcourir les éléments de logement selon la structure HTML fournie
    const logementsElements = $('.fr-grid-row.fr-grid-row--gutters li.fr-col-12');
    console.log(`🏠 Nombre d'éléments trouvés: ${logementsElements.length}`);

    logementsElements.each((index, element) => {
      const $elem = $(element);
      
      // Vérifier que c'est bien un élément de logement (avec une carte)
      const card = $elem.find('.fr-card');
      if (card.length === 0) {
        console.log(`⚠️  Élément ${index} ignoré: pas de carte`);
        return;
      }
      
      // Extraire les informations du logement
      const titre = $elem.find('.fr-card__title a').text().trim();
      const adresse = $elem.find('.fr-card__desc').text().trim();
      const prix = $elem.find('.fr-badge').first().text().trim();
      const lienLogement = $elem.find('.fr-card__title a').attr('href');
      
      console.log(`🏠 Logement trouvé: "${titre}" à ${adresse} - ${prix}`);
      
      // Extraire les détails (surface, type, équipements)
      const details = [];
      $elem.find('.fr-card__detail').each((i, detail) => {
        const detailText = $(detail).text().trim();
        if (detailText) details.push(detailText);
      });
      
      // Créer un identifiant unique basé sur le titre et l'adresse
      const id = `${titre}_${adresse}`.replace(/\s+/g, '_').replace(/[^\w_àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/gi, '');
      
      const logementData = {
        id,
        titre,
        adresse,
        prix,
        details: details.join(' | '),
        lien: lienLogement ? `https://trouverunlogement.lescrous.fr${lienLogement}` : CROUS_URL,
        surface: details.find(d => d.includes('m²')) || 'Surface non spécifiée',
        type: details.find(d => d.includes('Individuel') || d.includes('Collectif')) || 'Type non spécifié',
        equipements: details.find(d => d.includes('WC') || d.includes('Douche') || d.includes('Frigo')) || 'Équipements voir détail',
        derniereSeen: new Date()
      };
      
      console.log(`🔑 ID généré: ${id}`);
      
      // Ajouter le logement aux logements détectés actuellement
      logementsDetectes.set(id, logementData);
    });

    // Maintenant, vérifier quels logements nécessitent une notification
    const maintenant = new Date();
    const logementsANotifier = [];

    for (const [id, logement] of logementsDetectes) {
      const estNouveau = !logementsActuels.has(id);
      const derniereNotif = derniereNotification.get(id);
      const doitRenotifier = !derniereNotif || (maintenant - derniereNotif) >= INTERVALLE_RENOTIFICATION;
      
      if (estNouveau) {
        console.log(`🆕 Nouveau logement: ${logement.titre}`);
        logementsANotifier.push({ ...logement, typeNotification: 'NOUVEAU' });
      } else if (doitRenotifier) {
        const tempsEcoule = derniereNotif ? Math.round((maintenant - derniereNotif) / 60000) : 0;
        console.log(`🔄 Rappel pour: ${logement.titre} (${tempsEcoule} min depuis dernière notif)`);
        logementsANotifier.push({ ...logement, typeNotification: 'RAPPEL', tempsEcoule });
      } else {
        const prochainRappel = Math.round((INTERVALLE_RENOTIFICATION - (maintenant - derniereNotif)) / 60000);
        console.log(`⏳ ${logement.titre} - Prochain rappel dans ${prochainRappel} min`);
      }
    }

    // Identifier les logements qui ont disparu
    const logementsDisparus = [];
    for (const [id, logement] of logementsActuels) {
      if (!logementsDetectes.has(id)) {
        logementsDisparus.push(logement);
        console.log(`❌ Logement disparu: ${logement.titre}`);
      }
    }

    // Mettre à jour les logements actuels
    logementsActuels = new Map(logementsDetectes);

    // Envoyer les notifications nécessaires
    for (const logement of logementsANotifier) {
      await envoyerNotification(logement);
      derniereNotification.set(logement.id, maintenant);
    }

    // Envoyer notification de disparition si configuré
    if (logementsDisparus.length > 0 && process.env.NOTIFIER_DISPARITION === 'true') {
      for (const logement of logementsDisparus) {
        await envoyerNotificationDisparition(logement);
      }
    }

    // Nettoyer les anciennes notifications
    for (const id of derniereNotification.keys()) {
      if (!logementsActuels.has(id)) {
        derniereNotification.delete(id);
      }
    }

    // Résumé
    console.log(`📊 Résumé: ${logementsDetectes.size} disponible(s), ${logementsANotifier.length} notification(s) envoyée(s), ${logementsDisparus.length} disparu(s)`);

  } catch (error) {
    console.error('❌ Erreur lors de la vérification:', error.message);
    
    // En cas d'erreur de parsing, essayer une approche alternative
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      console.log('🔄 Problème de connexion, nouvelle tentative dans 30 secondes...');
    }
  }
}

// Fonction pour envoyer l'email de notification
async function envoyerNotification(logement) {
  try {
    const estNouveau = logement.typeNotification === 'NOUVEAU';
    const estRappel = logement.typeNotification === 'RAPPEL';
    
    const subject = estNouveau 
      ? `🆕 NOUVEAU logement CROUS: ${logement.titre}`
      : `🔔 RAPPEL logement CROUS: ${logement.titre}`;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: 'ouazizwalid.student@gmail.com',
      subject,
      html: `
        <h2>${estNouveau ? '🎉 Nouveau logement CROUS disponible' : '🔔 Rappel: Logement toujours disponible'} dans ${ZONE_SURVEILLEE} !</h2>
        <div style="background-color: #f0f8ff; padding: 20px; border-radius: 10px; font-family: Arial, sans-serif;">
          
          ${estRappel ? `
          <div style="background-color: #fff3cd; padding: 10px; border-radius: 5px; margin-bottom: 15px; border: 1px solid #ffeaa7;">
            <p style="margin: 0; font-weight: bold; color: #856404;">
              ⏰ Ce logement est disponible depuis ${logement.tempsEcoule} minutes - N'attendez plus !
            </p>
          </div>
          ` : ''}

          <div style="background-color: white; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid ${estNouveau ? '#28a745' : '#007bff'};">
            <h3 style="margin-top: 0; color: ${estNouveau ? '#28a745' : '#007bff'};">${estNouveau ? '🆕' : '🔄'} ${logement.titre}</h3>
            <p><strong>📍 Adresse:</strong> ${logement.adresse}</p>
            <p><strong>💰 Prix:</strong> ${logement.prix}</p>
            <p><strong>📐 Surface:</strong> ${logement.surface}</p>
            <p><strong>🏷️ Type:</strong> ${logement.type}</p>
            <p><strong>🔧 Équipements:</strong> ${logement.equipements}</p>
          </div>
          
          ${logement.details ? `
          <div style="background-color: #f8f9fa; padding: 10px; border-radius: 5px; margin-bottom: 15px;">
            <p><strong>📋 Détails complets:</strong> ${logement.details}</p>
          </div>
          ` : ''}
          
          <div style="margin-top: 20px; padding: 15px; background-color: ${estRappel ? '#f8d7da' : '#fff3cd'}; border-radius: 5px; border: 1px solid ${estRappel ? '#f5c6cb' : '#ffeaa7'};">
            <p style="margin: 0 0 15px 0;"><strong>⚠️ Action ${estRappel ? 'URGENTE' : 'requise'}:</strong> ${estRappel ? 'Ce logement est disponible depuis un moment !' : 'Rendez-vous rapidement sur le site pour postuler !'}</p>
            <div style="text-align: center;">
              <a href="${logement.lien}" style="background-color: ${estRappel ? '#dc3545' : '#007bff'}; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
                👉 ${estRappel ? 'POSTULER MAINTENANT' : 'Voir ce logement sur le site CROUS'}
              </a>
            </div>
          </div>
          
          <div style="margin-top: 15px; padding: 10px; background-color: #e8f5e8; border-radius: 5px;">
            <p style="margin: 0; font-size: 14px;"><strong>💡 Conseil:</strong> Les logements CROUS partent très vite ! Préparez vos documents à l'avance.</p>
            ${estRappel ? '<p style="margin: 5px 0 0 0; font-size: 12px; color: #666;"><em>Vous recevrez un rappel toutes les 5 minutes tant que ce logement reste disponible.</em></p>' : ''}
          </div>
          
          <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">
          
          <p style="margin: 0; font-size: 12px; color: #666; text-align: center;">
            📧 Email envoyé automatiquement le ${new Date().toLocaleString()} par votre Bot CROUS<br>
            🔍 Zone surveillée: ${ZONE_SURVEILLEE} | ⏱️ Vérification: toutes les 5 secondes<br>
            ${estRappel ? `🔔 Rappels: toutes les ${Math.round(INTERVALLE_RENOTIFICATION/60000)} minutes` : '🆕 Première détection'}
          </p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ Email ${estNouveau ? 'nouveau' : 'rappel'} envoyé pour: ${logement.titre} (${logement.prix})`);
    
  } catch (error) {
    console.error('❌ Erreur envoi email:', error.message);
  }
}

// Fonction pour envoyer une notification de disparition (optionnel)
async function envoyerNotificationDisparition(logement) {
  try {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: 'ouazizwalid.student@gmail.com',
      subject: `❌ Logement CROUS plus disponible: ${logement.titre}`,
      html: `
        <h2>❌ Logement CROUS plus disponible dans ${ZONE_SURVEILLEE}</h2>
        <div style="background-color: #f8d7da; padding: 20px; border-radius: 10px; font-family: Arial, sans-serif; border: 1px solid #f5c6cb;">
          <div style="background-color: white; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
            <h3 style="margin-top: 0; color: #dc3545;">❌ ${logement.titre}</h3>
            <p><strong>📍 Adresse:</strong> ${logement.adresse}</p>
            <p><strong>💰 Prix:</strong> ${logement.prix}</p>
            <p style="color: #dc3545; font-style: italic;">Ce logement ne semble plus être disponible sur le site CROUS.</p>
          </div>
          
          <p style="margin: 0; font-size: 12px; color: #666; text-align: center;">
            📧 Email envoyé automatiquement le ${new Date().toLocaleString()}
          </p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log(`📤 Notification de disparition envoyée pour: ${logement.titre}`);
    
  } catch (error) {
    console.error('❌ Erreur envoi email disparition:', error.message);
  }
}

// Fonction pour tester la configuration email
async function testEmail() {
  try {
    const testMail = {
      from: process.env.EMAIL_USER,
      to: 'ouazizwalid.student@gmail.com',
      subject: '🧪 Test Bot CROUS - Configuration OK',
      html: `
        <h2>✅ Bot de notification CROUS configuré avec succès !</h2>
        <p>Ce message confirme que votre bot de surveillance des logements CROUS fonctionne correctement.</p>
        <p><strong>Zone surveillée:</strong> ${ZONE_SURVEILLEE}</p>
        <p><strong>URL surveillée:</strong> ${CROUS_URL}</p>
        <p><strong>Fréquence:</strong> Toutes les 5 secondes</p>
        <p><strong>Rappels:</strong> Toutes les ${Math.round(INTERVALLE_RENOTIFICATION/60000)} minutes</p>
        <p><strong>Démarré le:</strong> ${new Date().toLocaleString()}</p>
      `
    };
    
    await transporter.sendMail(testMail);
    console.log('✅ Email de test envoyé avec succès');
  } catch (error) {
    console.error('❌ Erreur test email:', error.message);
  }
}

// Route pour vérifier le statut de l'application
app.get('/', (req, res) => {
  const stats = {
    status: 'Bot CROUS actif',
    zone: ZONE_SURVEILLEE,
    url_surveillance: CROUS_URL,
    email_destination: 'walidouaziz35@gmail.com',
    logements_actuels: logementsActuels.size,
    derniere_verification: new Date().toLocaleString(),
    intervalle_renotification_minutes: Math.round(INTERVALLE_RENOTIFICATION / 60000),
    logements_details: Array.from(logementsActuels.values()).map(l => ({
      titre: l.titre,
      prix: l.prix,
      depuis: l.derniereSeen.toLocaleString()
    }))
  };
  
  res.json(stats);
});

// Route pour forcer une vérification manuelle
app.get('/check-now', async (req, res) => {
  try {
    await checkLogements();
    res.json({ message: 'Vérification manuelle effectuée' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Route pour vider le cache des logements vus
app.get('/reset-cache', (req, res) => {
  const oldCount = logementsActuels.size;
  logementsActuels.clear();
  derniereNotification.clear();
  console.log(`🔄 Cache réinitialisé - ${oldCount} logement(s) oublié(s)`);
  res.json({ 
    message: 'Cache des logements réinitialisé', 
    logements_oublies: oldCount 
  });
});

// Route pour voir les logements actuellement disponibles
app.get('/logements-actuels', (req, res) => {
  const maintenant = new Date();
  const logements = Array.from(logementsActuels.values()).map(l => {
    const derniereNotif = derniereNotification.get(l.id);
    const prochainRappel = derniereNotif ? new Date(derniereNotif.getTime() + INTERVALLE_RENOTIFICATION) : new Date();
    
    return {
      ...l,
      derniere_notification: derniereNotif ? derniereNotif.toLocaleString() : 'Jamais',
      prochain_rappel: prochainRappel > maintenant ? prochainRappel.toLocaleString() : 'Maintenant',
      minutes_depuis_detection: Math.round((maintenant - l.derniereSeen) / 60000),
      minutes_depuis_derniere_notif: derniereNotif ? Math.round((maintenant - derniereNotif) / 60000) : null
    };
  });
  
  res.json({
    nombre_logements_actuels: logementsActuels.size,
    intervalle_rappel_minutes: Math.round(INTERVALLE_RENOTIFICATION / 60000),
    logements
  });
});

// Route pour forcer un rappel immédiat pour tous les logements
app.get('/forcer-rappels', async (req, res) => {
  try {
    let rappelsEnvoyes = 0;
    const maintenant = new Date();
    
    for (const [id, logement] of logementsActuels) {
      await envoyerNotification({ ...logement, typeNotification: 'RAPPEL', tempsEcoule: Math.round((maintenant - logement.derniereSeen) / 60000) });
      derniereNotification.set(id, maintenant);
      rappelsEnvoyes++;
    }
    
    console.log(`🔔 ${rappelsEnvoyes} rappel(s) forcé(s) envoyé(s)`);
    res.json({ 
      message: `${rappelsEnvoyes} rappel(s) envoyé(s)`,
      logements_rappeles: rappelsEnvoyes
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Démarrage de l'application
app.listen(PORT, async () => {
  console.log(`🚀 Bot CROUS démarré sur le port ${PORT}`);
  console.log(`📍 Surveillance: ${ZONE_SURVEILLEE}`);
  console.log(`🌐 URL: ${CROUS_URL}`);
  console.log(`📧 Notifications: walidouaziz35@gmail.com`);
  console.log(`🔄 Vérification: Toutes les 5 secondes`);
  console.log(`🔔 Rappels: Toutes les ${Math.round(INTERVALLE_RENOTIFICATION/60000)} minutes\n`);
  
  // Test initial de l'email
  await testEmail();
  
  // Première vérification
  await checkLogements();
  
  // Programmer les vérifications toutes les 5 secondes
  setInterval(checkLogements, 5000);
});

// Gestion des erreurs non capturées
process.on('uncaughtException', (error) => {
  console.error('❌ Erreur non capturée:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rejetée:', reason);
});