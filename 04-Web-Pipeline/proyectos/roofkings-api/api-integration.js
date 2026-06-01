/* ==============================================
   ROOF KINGS — API Integration
   Conecta al backend multi-marca en Railway
   ============================================== */

(function(){
  'use strict';

  /* ---------- CONFIGURACION ---------- */
  var BRAND = 'roof-kings';
  var API_BASE = 'https://dependable-luck-production-7edf.up.railway.app';
  var WHATSAPP_NUMBER = '19495612069';
  var PHONE_NUMBER = '+18584658919';

  /* ---------- 1. Formulario de cotizacion ---------- */
  var quoteForm = document.getElementById('quoteForm');
  if (quoteForm) {
    quoteForm.addEventListener('submit', function(e) {
      e.preventDefault();

      var formData = new FormData(quoteForm);
      var payload = {
        brand: BRAND,
        name: formData.get('name') || '',
        phone: formData.get('phone') || '',
        jobType: formData.get('jobType') || '',
        bestTime: formData.get('bestTime') || '',
        lang: document.documentElement.lang || 'en',
        source: 'Website'
      };

      var photosInput = quoteForm.querySelector('input[type="file"]');
      var hasFiles = photosInput && photosInput.files && photosInput.files.length > 0;

      var submitBtn = quoteForm.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Enviando...';
      }

      function redirectToThanks() {
        window.location.href = '/gracias';
      }

      var done = false;
      function finish() {
        if (done) return;
        done = true;
        redirectToThanks();
      }

      // Safety timeout — redirect after 8s even if fetch hasn't completed
      var safetyTimer = setTimeout(finish, 8000);

      var request;
      if (hasFiles) {
        var fd = new FormData();
        fd.append('brand', BRAND);
        fd.append('name', payload.name);
        fd.append('phone', payload.phone);
        fd.append('jobType', payload.jobType);
        fd.append('bestTime', payload.bestTime);
        fd.append('lang', payload.lang);
        fd.append('source', payload.source);
        for (var i = 0; i < photosInput.files.length; i++) {
          fd.append('photos', photosInput.files[i]);
        }
        request = fetch(API_BASE + '/api/quote', { method: 'POST', body: fd });
      } else {
        var photos = [];
        var base64Inputs = quoteForm.querySelectorAll('input[type="hidden"][data-photo]');
        for (var j = 0; j < base64Inputs.length; j++) {
          photos.push(base64Inputs[j].value);
        }
        if (photos.length > 0) payload.photos = photos;
        request = fetch(API_BASE + '/api/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

      request.then(function(res) {
        return res.json();
      }).then(function(data) {
        console.log('Quote submitted:', data);
      }).catch(function(err) {
        console.error('Quote submit error:', err);
      }).finally(function() {
        clearTimeout(safetyTimer);
        finish();
      });

      // Tracking
      if (typeof gtag !== 'undefined') {
        gtag('event', 'generate_lead', {
          event_category: 'lead',
          event_label: 'Quote Form Submit'
        });
      }
      if (typeof fbq !== 'undefined') {
        fbq('track', 'Lead', { content_name: 'Quote Form Submit', content_category: 'lead' });
      }
    });
  }

  /* ---------- 2. Clics en telefono ---------- */
  document.querySelectorAll('a[href^="tel:"]').forEach(function(link) {
    link.addEventListener('click', function() {
      if (typeof gtag !== 'undefined') {
        gtag('event', 'contact', { event_category: 'contact', event_label: 'Phone Call' });
      }
      if (typeof fbq !== 'undefined') {
        fbq('track', 'Contact', { content_name: 'Phone Call', content_category: 'contact' });
      }
    });
  });

  /* ---------- 3. WhatsApp click → Telegram ---------- */
  function notifyWhatsAppClick() {
    // Notifica al backend para que mande mensaje a Telegram
    fetch(API_BASE + '/api/whatsapp-click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: BRAND, whatsappNumber: WHATSAPP_NUMBER })
    }).catch(function(){});

    // Tracking
    if (typeof gtag !== 'undefined') {
      gtag('event', 'contact', { event_category: 'contact', event_label: 'WhatsApp Message' });
    }
    if (typeof fbq !== 'undefined') {
      fbq('track', 'Contact', { content_name: 'WhatsApp Message', content_category: 'contact' });
    }
  }

  // WhatsApp button
  var stickyWhatsapp = document.getElementById('stickyWhatsapp');
  if (stickyWhatsapp) {
    stickyWhatsapp.addEventListener('click', notifyWhatsAppClick);
  }

  // Cualquier otro enlace de WhatsApp en la pagina
  document.querySelectorAll('a[href*="wa.me"]').forEach(function(link) {
    if (link !== stickyWhatsapp) {
      link.addEventListener('click', notifyWhatsAppClick);
    }
  });

  /* ---------- 4. Verificacion rapida ---------- */
  console.log('[Roof Kings] API configurada: ' + API_BASE + ' | brand: ' + BRAND);
  console.log('[Roof Kings] WhatsApp: ' + WHATSAPP_NUMBER + ' | Phone: ' + PHONE_NUMBER);

})();
