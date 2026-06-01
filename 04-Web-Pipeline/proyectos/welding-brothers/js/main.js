/* ==============================================
   THE WELDING BROTHERS — Main JavaScript
   GSAP ScrollTrigger · Language Toggle · Hero Tabs
   Form Handler · Lightbox · Mobile Menu
   ============================================== */
(function(){
  'use strict';

  /* ---------- Mobile Menu ---------- */
  const hamburger = document.getElementById('hamburger');
  const mobileMenu = document.getElementById('mobileMenu');
  const mobileLinks = document.querySelectorAll('.mobile-link');

  if(hamburger && mobileMenu){
    hamburger.addEventListener('click',function(){
      hamburger.classList.toggle('active');
      mobileMenu.classList.toggle('open');
      const isOpen = mobileMenu.classList.contains('open');
      hamburger.setAttribute('aria-expanded',isOpen);
      document.body.style.overflow = isOpen ? 'hidden' : '';
    });
    mobileLinks.forEach(function(link){
      link.addEventListener('click',function(){
        hamburger.classList.remove('active');
        mobileMenu.classList.remove('open');
        hamburger.setAttribute('aria-expanded','false');
        document.body.style.overflow = '';
      });
    });
  }

  /* ---------- Video Playback Speed ---------- */
  document.querySelectorAll('video').forEach(function(video){
    video.playbackRate = 0.8;
  });

  /* ---------- Nav Scroll Effect ---------- */
  const nav = document.getElementById('nav');
  window.addEventListener('scroll',function(){
    if(window.pageYOffset > 50){
      nav.classList.add('scrolled');
    } else {
      nav.classList.remove('scrolled');
    }
  },{passive:true});

  /* ---------- Language Toggle ---------- */
  const langBtns = document.querySelectorAll('.lang-btn');
  let currentLang = localStorage.getItem('twb-lang') || 'en';

  function switchLang(lang){
    currentLang = lang;
    localStorage.setItem('twb-lang',lang);

    langBtns.forEach(function(btn){
      btn.classList.toggle('active',btn.getAttribute('data-lang') === lang);
    });

    document.querySelectorAll('[data-en][data-es]').forEach(function(el){
      const text = el.getAttribute('data-' + lang);
      if(text !== null && text !== undefined){
        if(el.children.length === 0){
          el.textContent = text;
        } else {
          updateFirstTextNode(el,text);
        }
      }
    });

    document.querySelectorAll('[data-en-placeholder][data-es-placeholder]').forEach(function(el){
      el.placeholder = el.getAttribute('data-' + lang + '-placeholder') || '';
    });

    document.querySelectorAll('select option').forEach(function(opt){
      const optText = opt.getAttribute('data-' + lang);
      if(optText) opt.textContent = optText;
    });

    document.documentElement.lang = lang;
  }

  function updateFirstTextNode(el,text){
    for(let child of el.childNodes){
      if(child.nodeType === Node.TEXT_NODE){
        child.textContent = text;
        return;
      }
    }
    el.insertBefore(document.createTextNode(text),el.firstChild);
  }

  langBtns.forEach(function(btn){
    btn.addEventListener('click',function(){
      switchLang(btn.getAttribute('data-lang'));
    });
  });

  switchLang(currentLang);

  /* ---------- Gallery Lightbox ---------- */
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  const galleryImgs = document.querySelectorAll('.gallery-img');

  if(lightbox && lightboxImg){
    galleryImgs.forEach(function(img){
      img.addEventListener('click',function(){
        const fullSrc = img.getAttribute('data-full') || img.src;
        lightboxImg.src = fullSrc;
        lightboxImg.alt = img.alt;
        lightbox.classList.add('show');
        document.body.style.overflow = 'hidden';
      });
    });

    lightbox.addEventListener('click',function(e){
      if(e.target === lightbox || e.target.classList.contains('lightbox-close')){
        lightbox.classList.remove('show');
        document.body.style.overflow = '';
      }
    });

    document.addEventListener('keydown',function(e){
      if(e.key === 'Escape' && lightbox.classList.contains('show')){
        lightbox.classList.remove('show');
        document.body.style.overflow = '';
      }
    });
  }

  /* ---------- Photo Upload ---------- */
  const photoYes = document.getElementById('photoYes');
  const photoNo = document.getElementById('photoNo');
  const photoUpload = document.getElementById('photoUpload');
  const photoInput = document.getElementById('photos');
  const photoPreviews = document.getElementById('photoPreviews');
  let selectedFiles = [];

  if(photoYes && photoNo && photoUpload){
    photoYes.addEventListener('click',function(){
      photoUpload.classList.remove('hidden');
      photoYes.classList.add('active');
      photoNo.classList.remove('active');
    });
    photoNo.addEventListener('click',function(){
      photoUpload.classList.add('hidden');
      photoNo.classList.add('active');
      photoYes.classList.remove('active');
      selectedFiles = [];
      if(photoInput) photoInput.value = '';
      if(photoPreviews) photoPreviews.innerHTML = '';
    });
  }

  if(photoInput && photoPreviews){
    photoInput.addEventListener('change',function(e){
      const newFiles = Array.from(e.target.files);
      if(newFiles.length === 0) return;

      // Check total would exceed 5
      if(selectedFiles.length + newFiles.length > 5){
        alert(currentLang === 'es' ? 'Máximo 5 fotos en total.' : 'Maximum 5 photos total.');
        photoInput.value = '';
        return;
      }

      // Validate each file size
      const oversized = newFiles.filter(function(f){ return f.size > 10 * 1024 * 1024; });
      if(oversized.length > 0){
        alert(currentLang === 'es' ? 'Cada foto debe ser menor a 10MB.' : 'Each photo must be under 10MB.');
        photoInput.value = '';
        return;
      }

      // Validate file types
      const allowed = ['image/jpeg','image/png','image/heic','image/heif'];
      const invalid = newFiles.filter(function(f){ return !allowed.includes(f.type); });
      if(invalid.length > 0){
        alert(currentLang === 'es' ? 'Solo JPG, PNG y HEIC permitidos.' : 'Only JPG, PNG and HEIC allowed.');
        photoInput.value = '';
        return;
      }

      // Accumulate new files
      selectedFiles = selectedFiles.concat(newFiles);

      // Re-render all previews
      renderPreviews();

      // Reset input so re-selecting the same file triggers change
      photoInput.value = '';
    });
  }

  function renderPreviews(){
    if(!photoPreviews) return;
    photoPreviews.innerHTML = '';
    selectedFiles.forEach(function(file, index){
      const reader = new FileReader();
      reader.onload = function(ev){
        const wrapper = document.createElement('div');
        wrapper.className = 'preview-wrapper';

        const img = document.createElement('img');
        img.src = ev.target.result;
        img.alt = file.name;
        img.title = file.name;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'preview-remove';
        removeBtn.innerHTML = '&times;';
        removeBtn.title = currentLang === 'es' ? 'Quitar foto' : 'Remove photo';
        removeBtn.addEventListener('click', function(){
          selectedFiles.splice(index, 1);
          renderPreviews();
        });

        wrapper.appendChild(img);
        wrapper.appendChild(removeBtn);
        photoPreviews.appendChild(wrapper);
      };
      reader.readAsDataURL(file);
    });
  }

  /* ---------- Form Submit ---------- */
  const quoteForm = document.getElementById('quoteForm');
  const formMessage = document.getElementById('formMessage');

  if(quoteForm){
    quoteForm.addEventListener('submit',function(e){
      e.preventDefault();
      const submitBtn = quoteForm.querySelector('.btn-submit');
      const originalHTML = submitBtn.innerHTML;

      const name = document.getElementById('name').value.trim();
      const phone = document.getElementById('phone').value.trim();
      const jobType = document.getElementById('jobType').value;

      if(!name || !phone || !jobType){
        showFormMessage('error',
          currentLang === 'es' ? 'Por favor llena todos los campos requeridos.' : 'Please fill in all required fields.'
        );
        return;
      }

      submitBtn.innerHTML = currentLang === 'es' ? 'Enviando...' : 'Sending...';
      submitBtn.disabled = true;
      showFormMessage('loading',
        currentLang === 'es' ? 'Enviando tu solicitud...' : 'Sending your request...'
      );

      const payload = {
        name: name,
        phone: phone,
        jobType: jobType,
        bestTime: document.getElementById('bestTime').value || 'anytime',
        lang: currentLang,
        submittedAt: new Date().toISOString()
      };

      if(selectedFiles.length > 0){
        payload.photos = [];
        const readers = [];
        selectedFiles.forEach(function(file){
          readers.push(new Promise(function(resolve){
            const reader = new FileReader();
            reader.onload = function(ev){ resolve({name:file.name,data:ev.target.result}); };
            reader.readAsDataURL(file);
          }));
        });
        Promise.all(readers).then(function(photos){
          payload.photos = photos;
          sendForm(payload,submitBtn,originalHTML);
        });
      } else {
        sendForm(payload,submitBtn,originalHTML);
      }
    });
  }

  function sendForm(payload,submitBtn,originalHTML){
    var endpoint = 'https://dependable-luck-production-7edf.up.railway.app/api/quote';
    var redirected = false;

    function go() {
      if (redirected) return;
      redirected = true;
      try { trackConversion('Lead', { content_name: 'Quote Form Submit', content_category: 'lead', status: 'submitted' }); } catch(e) {}
      window.location.href = '/gracias';
    }

    // Safety timeout — redirect after 8s even if API hangs
    var safety = setTimeout(go, 8000);

    fetch(endpoint,{
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    })
    .then(function(res){
      clearTimeout(safety);
      go();
    })
    .catch(function(){
      clearTimeout(safety);
      go();
    });
  }

  function resetForm(){
    quoteForm.reset();
    if(photoPreviews) photoPreviews.innerHTML = '';
    selectedFiles = [];
    if(photoUpload) photoUpload.classList.add('hidden');
    if(photoYes) photoYes.classList.remove('active');
    if(photoNo) photoNo.classList.add('active');
  }

  function showFormMessage(type,text){
    if(!formMessage) return;
    formMessage.className = 'form-message ' + type;
    formMessage.textContent = text;
    formMessage.classList.remove('hidden');
    if(type === 'success'){
      setTimeout(function(){ formMessage.classList.add('hidden'); },8000);
    }
  }

  /* ---------- GSAP Scroll Animations ---------- */
  if(typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined'){
    gsap.registerPlugin(ScrollTrigger);

    // Hero text reveal sequence
    const heroTL = gsap.timeline({defaults:{ease:'power3.out'}});
    heroTL.fromTo('.hero h1',{opacity:0,y:50},{opacity:1,y:0,duration:0.8},0.2);
    heroTL.fromTo('.hero-sub',{opacity:0,y:30},{opacity:1,y:0,duration:0.7},0.4);
    heroTL.fromTo('.hero-ctas',{opacity:0,y:30},{opacity:1,y:0,duration:0.7},0.6);

    // Scroll-triggered reveals
    const animateElements = document.querySelectorAll('[data-animate]');
    animateElements.forEach(function(el){
      const animType = el.getAttribute('data-animate');
      gsap.fromTo(el,
        {opacity:0, y: animType === 'fade-right' ? -40 : animType === 'fade-left' ? 40 : 40},
        {
          opacity:1,y:0,duration:0.8,ease:'power3.out',
          scrollTrigger:{
            trigger:el,
            start:'top 85%',
            once:true,
            toggleActions:'play none none none'
          }
        }
      );
    });

    // Service cards stagger
    ScrollTrigger.batch('.service-card',{
      start:'top 85%',
      once:true,
      onEnter:function(batch){
        gsap.fromTo(batch,{opacity:0,y:40},{opacity:1,y:0,stagger:0.12,duration:0.7,ease:'power3.out'});
      }
    });

    // Warranty cards stagger
    ScrollTrigger.batch('.warranty-card',{
      start:'top 85%',
      once:true,
      onEnter:function(batch){
        gsap.fromTo(batch,{opacity:0,y:40},{opacity:1,y:0,stagger:0.15,duration:0.7,ease:'power3.out'});
      }
    });

    // Warranty shield
    gsap.fromTo('.warranty-shield',{opacity:0,scale:0.8},{opacity:1,scale:1,duration:1,ease:'back.out(1.4)',scrollTrigger:{trigger:'.warranty-module',start:'top 80%',once:true}});

    // Testimonial cards stagger
    ScrollTrigger.batch('.testimonial-card',{
      start:'top 85%',
      once:true,
      onEnter:function(batch){
        gsap.fromTo(batch,{opacity:0,y:40},{opacity:1,y:0,stagger:0.12,duration:0.7,ease:'power3.out'});
      }
    });

    // Why cards stagger
    ScrollTrigger.batch('.why-card',{
      start:'top 85%',
      once:true,
      onEnter:function(batch){
        gsap.fromTo(batch,{opacity:0,y:40},{opacity:1,y:0,stagger:0.12,duration:0.7,ease:'power3.out'});
      }
    });

    // Gallery items stagger
    ScrollTrigger.batch('.gallery-item',{
      start:'top 85%',
      once:true,
      onEnter:function(batch){
        gsap.fromTo(batch,{opacity:0,y:40,scale:0.95},{opacity:1,y:0,scale:1,stagger:0.1,duration:0.6,ease:'power3.out'});
      }
    });

    // Trust bar
    gsap.fromTo('.trust-bar',{opacity:0},{opacity:1,duration:0.8,scrollTrigger:{trigger:'.trust-bar',start:'top 90%',once:true}});

    // Sticky WhatsApp — appear at Warranty, disappear when scrolling back up
    const stickyBtn = document.getElementById('stickyWhatsapp');
    if(stickyBtn){
      ScrollTrigger.create({
        trigger:'#warranty',
        start:'top bottom',
        onEnter:function(){ stickyBtn.classList.add('visible'); },
        onLeaveBack:function(){ stickyBtn.classList.remove('visible'); }
      });
    }
  }

  /* ---------- Conversion Tracking (Meta Pixel + Google Ads via GA4) ---------- */
  // Sends events to both Meta Pixel and Google Analytics 4
  function trackConversion(eventName, params) {
    // Meta Pixel
    if (typeof fbq !== 'undefined') {
      fbq('track', eventName, params);
    }
    // Google Analytics 4 → Google Ads imports these as conversions
    if (typeof gtag !== 'undefined') {
      var ga4Event = eventName === 'Lead' ? 'generate_lead' :
                     eventName === 'Contact' ? 'contact' :
                     eventName === 'ViewContent' ? 'view_content' : eventName.toLowerCase();
      gtag('event', ga4Event, params);
    }
  }

  // 1. ViewContent — fire once per section when scrolled into view
  var pixelFired = {};

  function fireViewContent(section, label) {
    if (pixelFired[section]) return;
    pixelFired[section] = true;
    trackConversion('ViewContent', { content_name: label, content_category: section });
  }

  if (typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined') {
    // Services section
    ScrollTrigger.create({
      trigger: '#services',
      start: 'top 70%',
      once: true,
      onEnter: function() { fireViewContent('services', 'Services — Heavy-Duty Fabrication'); }
    });
    // Gallery section
    ScrollTrigger.create({
      trigger: '#gallery',
      start: 'top 70%',
      once: true,
      onEnter: function() { fireViewContent('gallery', 'Gallery — Our Work'); }
    });
    // Warranty section
    ScrollTrigger.create({
      trigger: '#warranty',
      start: 'top 70%',
      once: true,
      onEnter: function() { fireViewContent('warranty', 'Warranty — Built to Last'); }
    });
  }

  // 2. Contact — phone clicks & WhatsApp
  document.querySelectorAll('a[href^="tel:"]').forEach(function(link) {
    link.addEventListener('click', function() {
      trackConversion('Contact', { content_name: 'Phone Call', content_category: 'contact' });
    });
  });

  var stickyWhatsapp = document.getElementById('stickyWhatsapp');
  if (stickyWhatsapp) {
    stickyWhatsapp.addEventListener('click', function() {
      trackConversion('Contact', { content_name: 'WhatsApp Message', content_category: 'contact' });
      fetch('https://dependable-luck-production-7edf.up.railway.app/api/whatsapp-click', { method: 'POST', mode: 'no-cors' }).catch(function(){});
    });
  }

  // 3. Lead — fires on successful form submission
  var leadTracked = false;
  var originalShowFormMessage = showFormMessage;
  showFormMessage = function(type, text) {
    if (type === 'success' && !leadTracked) {
      leadTracked = true;
      trackConversion('Lead', {
        content_name: 'Quote Form Submit',
        content_category: 'lead',
        status: 'submitted'
      });
      setTimeout(function() { leadTracked = false; }, 5000);
    }
    return originalShowFormMessage(type, text);
  };

})();
