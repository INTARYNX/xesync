/* =============================================================
 * XEsync — shared runtime
 *  - Boosted logo wave (bloom + chromatic sheen + scanlines)
 *  - Scroll-reveal via IntersectionObserver
 * ============================================================= */
(function () {
  'use strict';

  /* ── LOGO ANIMATION ─────────────────────────────────────── */
  var LOGO_FONT_SPEC = '700 120px "Courier Prime", "Courier New", Courier, monospace';

  var canvas = document.getElementById('bg');
  if (canvas && canvas.getContext) {
    var ctx = canvas.getContext('2d');

    function sizeCanvas() {
      canvas.width = window.innerWidth;
      var topPad = window.innerWidth < 900 ? 80 : 100;
      canvas.height = topPad + 220;
    }
    sizeCanvas();
    window.addEventListener('resize', sizeCanvas);

    var t = 0;
    var logoCanvas = null;
    var animationStarted = false;
    var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    var frame = 0;
    var lastTime = 0;
    var logoVisible = true;

    // Decorative telemetry, inspired by the rowing screen's metric palette.
    // All signals are procedural: no workout data is represented here.
    function drawGraphs(topPad) {
      var width = Math.min(canvas.width - 24, 1100);
      var left = (canvas.width - width) / 2;
      var top = topPad + 8;
      var height = 182;
      var colors = ['0, 212, 255', '169, 132, 255', '255, 104, 176', '255, 199, 48'];
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, width, height);
      ctx.clip();

      var fade = ctx.createLinearGradient(left, 0, left + width, 0);
      fade.addColorStop(0, 'rgba(0, 212, 255, 0)');
      fade.addColorStop(0.15, 'rgba(0, 212, 255, 0.09)');
      fade.addColorStop(0.85, 'rgba(0, 212, 255, 0.09)');
      fade.addColorStop(1, 'rgba(0, 212, 255, 0)');
      ctx.strokeStyle = fade;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var gx = left - (t * 9 % 36); gx < left + width; gx += 36) {
        ctx.moveTo(gx, top); ctx.lineTo(gx, top + height);
      }
      for (var gy = top + 16; gy < top + height; gy += 30) {
        ctx.moveTo(left, gy); ctx.lineTo(left + width, gy);
      }
      ctx.stroke();

      for (var channel = 0; channel < colors.length; channel++) {
        var trace = ctx.createLinearGradient(left, 0, left + width, 0);
        trace.addColorStop(0, 'rgba(' + colors[channel] + ', 0)');
        trace.addColorStop(0.12, 'rgba(' + colors[channel] + ', 0.42)');
        trace.addColorStop(0.4, 'rgba(' + colors[channel] + ', 0.12)');
        trace.addColorStop(0.6, 'rgba(' + colors[channel] + ', 0.12)');
        trace.addColorStop(0.88, 'rgba(' + colors[channel] + ', 0.42)');
        trace.addColorStop(1, 'rgba(' + colors[channel] + ', 0)');
        ctx.strokeStyle = trace;
        ctx.lineWidth = channel === 0 ? 1.6 : 1;
        ctx.beginPath();
        for (var x = 0; x <= width; x += 3) {
          var phase = x * 0.022 + t * 0.8 + channel * 2.1;
          var stroke = Math.pow((Math.sin(phase * 1.8) + 1) / 2, 8);
          var signal = Math.sin(phase) * 10 + Math.sin(phase * 0.43 + channel) * 14;
          var y = top + 43 + channel * 32 + signal - stroke * (channel === 2 ? 28 : 12);
          if (x === 0) ctx.moveTo(left + x, y);
          else ctx.lineTo(left + x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    function buildLogo() {
      logoCanvas = document.createElement('canvas');
      logoCanvas.width = 700;
      logoCanvas.height = 180;
      var lc = logoCanvas.getContext('2d');
      lc.imageSmoothingEnabled = false;

      var grad = lc.createLinearGradient(0, 0, 0, logoCanvas.height);
      grad.addColorStop(0,   '#00d4ff');
      grad.addColorStop(0.5, '#0099ff');
      grad.addColorStop(1,   '#0066cc');

      lc.font = LOGO_FONT_SPEC;
      lc.textAlign = 'left';
      lc.textBaseline = 'middle';

      var cx = logoCanvas.width / 2;
      var cy = logoCanvas.height / 2;
      var wXE  = lc.measureText('XE').width;
      var wSyn = lc.measureText('sync').width;
      var x0 = cx - (wXE + wSyn) / 2;

      lc.fillStyle = '#c3e1fa';
      lc.fillText('XE', x0, cy);
      lc.fillStyle = grad;
      lc.fillText('sync', x0 + wXE, cy);
    }

    function draw(now) {
      frame = 0;
      if (now && lastTime && !reducedMotion.matches) t += Math.min(now - lastTime, 50) * 0.0024;
      lastTime = now || 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!logoCanvas) return;

      var drawW = Math.min(logoCanvas.width, window.innerWidth * 0.78);
      var scale = drawW / logoCanvas.width;
      var drawH = logoCanvas.height * scale;
      var cx = canvas.width / 2 - drawW / 2;
      var topPad = window.innerWidth < 900 ? 80 : 100;
      var ty = topPad + (200 - drawH) / 2;
      drawGraphs(topPad);

      // Wave position (0..1) — same math as the original
      var wp = Math.sin(t * 0.4) * 0.5 + 0.5;

      /* Pass 1 — main wave (the original animation, intact) */
      for (var y = 0; y < logoCanvas.height; y++) {
        var yN  = y / logoCanvas.height;
        var wi  = Math.max(0, 1 - Math.abs(yN - wp) * 3);
        var amp = 6 + 15 * wi;
        var off = amp * Math.sin(y * 0.025 + t);

        ctx.drawImage(
          logoCanvas,
          0, y, logoCanvas.width, 1,
          cx + off, ty + y * scale, drawW, scale + 0.5
        );
      }

      /* Pass 2 — bloom: a brighter copy of the logo, only on the lines
         where the wave is near its peak. By reusing the logo canvas as the
         bloom source, the glow is clipped to the text shape — no more
         solid cyan bar leaking through the empty space between letters. */
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (var by = 0; by < logoCanvas.height; by++) {
        var byN = by / logoCanvas.height;
        var bwi = Math.max(0, 1 - Math.abs(byN - wp) * 3);
        if (bwi < 0.35) continue;
        var bamp = 6 + 15 * bwi;
        var boff = bamp * Math.sin(by * 0.025 + t);
        var bintensity = (bwi - 0.35) / 0.65 * 0.55;
        ctx.globalAlpha = bintensity;
        ctx.drawImage(
          logoCanvas,
          0, by, logoCanvas.width, 1,
          cx + boff, ty + by * scale, drawW, scale + 0.5
        );
      }
      ctx.restore();

      /* Pass 3 — chromatic sheen: ghosted copies of the wave-peak rows
         offset ±1.5px, additive. Approximates an RGB split without
         fighting the cyan/blue palette. */
      var peakLineY = Math.round(wp * logoCanvas.height);
      for (var dy = -2; dy <= 2; dy++) {
        var yy = peakLineY + dy;
        if (yy < 0 || yy >= logoCanvas.height) continue;
        var yN2 = yy / logoCanvas.height;
        var wi2 = Math.max(0, 1 - Math.abs(yN2 - wp) * 3);
        if (wi2 < 0.25) continue;
        var amp2 = 6 + 15 * wi2;
        var off2 = amp2 * Math.sin(yy * 0.025 + t);
        var intensity = wi2 * 0.22;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = intensity;
        ctx.drawImage(logoCanvas, 0, yy, logoCanvas.width, 1,
          cx + off2 + 1.5, ty + yy * scale, drawW, scale + 0.5);
        ctx.drawImage(logoCanvas, 0, yy, logoCanvas.width, 1,
          cx + off2 - 1.5, ty + yy * scale, drawW, scale + 0.5);
        ctx.restore();
      }

      /* Pass 4 — subtle scanlines (CRT hint, 1px every 3px, alpha 0.06) */
      ctx.save();
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = '#000';
      for (var sy = 0; sy < drawH; sy += 3) {
        ctx.fillRect(cx, ty + sy, drawW, 1);
      }
      ctx.restore();

      if (!reducedMotion.matches && !document.hidden && logoVisible) frame = requestAnimationFrame(draw);
    }

    function refreshAnimation() {
      cancelAnimationFrame(frame);
      lastTime = 0;
      if (animationStarted) draw();
    }
    reducedMotion.addEventListener('change', refreshAnimation);
    document.addEventListener('visibilitychange', refreshAnimation);
    window.addEventListener('resize', refreshAnimation);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        logoVisible = entries[0].isIntersecting;
        refreshAnimation();
      }).observe(canvas);
    }

    function start() {
      if (animationStarted) return;
      animationStarted = true;
      buildLogo();
      draw();
    }

    if (document.fonts && document.fonts.load) {
      document.fonts.load(LOGO_FONT_SPEC, 'XEsync')
        .then(function () { return document.fonts.ready; })
        .then(function () {
          if (!document.fonts.check(LOGO_FONT_SPEC)) setTimeout(start, 100);
          else start();
        })
        .catch(function () { start(); });
    } else {
      window.addEventListener('load', function () { setTimeout(start, 300); });
    }
  }

  /* Native dialog keeps keyboard focus inside the image viewer. Links still
     open the original image if JavaScript or dialog support is unavailable. */
  var shots = document.querySelectorAll('.screenshot-link');
  if (shots.length && typeof HTMLDialogElement !== 'undefined') {
    var viewer = document.createElement('dialog');
    viewer.className = 'image-viewer';
    viewer.setAttribute('aria-label', 'Screenshot viewer');
    viewer.innerHTML = '<div class="viewer-toolbar"><button type="button" class="viewer-zoom" aria-pressed="false">Zoom in</button><button type="button" class="viewer-close" autofocus>Close <span aria-hidden="true">×</span></button></div><div class="viewer-scroll"><img class="viewer-image" alt=""></div><p class="viewer-caption"></p>';
    document.body.appendChild(viewer);
    var fullImage = viewer.querySelector('img');
    var zoom = viewer.querySelector('.viewer-zoom');
    var scroller = viewer.querySelector('.viewer-scroll');
    var opener;
    var previousOverflow;
    shots.forEach(function (link) {
      link.addEventListener('click', function (event) {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        opener = link;
        fullImage.src = link.href;
        fullImage.alt = link.querySelector('img').alt;
        viewer.querySelector('.viewer-caption').textContent = fullImage.alt;
        viewer.classList.remove('is-zoomed');
        zoom.textContent = 'Zoom in';
        zoom.setAttribute('aria-pressed', 'false');
        previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        viewer.showModal();
        scroller.scrollTo(0, 0);
      });
    });
    zoom.addEventListener('click', function () {
      var expanded = viewer.classList.toggle('is-zoomed');
      zoom.textContent = expanded ? 'Fit image' : 'Zoom in';
      zoom.setAttribute('aria-pressed', String(expanded));
      scroller.scrollTo(0, 0);
    });
    viewer.querySelector('.viewer-close').addEventListener('click', function () { viewer.close(); });
    viewer.addEventListener('click', function (event) {
      if (event.target === viewer) {
        var bounds = viewer.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) viewer.close();
      }
    });
    viewer.addEventListener('close', function () {
      document.body.style.overflow = previousOverflow;
      if (opener) opener.focus({ preventScroll: true });
    });
  }

  /* ── SCROLL REVEAL ──────────────────────────────────────── */
  var revealEls = document.querySelectorAll('.reveal');
  if (revealEls.length) {
    if ('IntersectionObserver' in window) {
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            obs.unobserve(e.target);
          }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });
      revealEls.forEach(function (el) { obs.observe(el); });
    } else {
      // No IO support: just show everything
      revealEls.forEach(function (el) { el.classList.add('in'); });
    }
  }
})();
