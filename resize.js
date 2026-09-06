(function(){
  "use strict";

  /* Каждая панель — теперь свободно перемещаемое/изменяемое "окно":
     - тянуть за шапку (chart-header / sidebar-topbar) — перемещение
     - тянуть за правый нижний угол (нативный CSS resize) — изменение размера
     Позиция и размер запоминаются в localStorage отдельно для каждой панели. */

  const WINDOWS = [
    { el: document.getElementById('chartPane'),    key: 'win:chartPane',    header: '.chart-header'   },
    { el: document.getElementById('screenerPane'), key: 'win:screenerPane', header: '.sidebar-topbar' }
  ];

  const MIN_W = 160, MIN_H = 120;
  const isMobile = () => window.innerWidth <= 900;
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  function loadState(key){
    try{
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }catch(_){ return null; }
  }
  function saveState(key, state){
    try{ localStorage.setItem(key, JSON.stringify(state)); }catch(_){}
  }
  function currentState(el){
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  function applyState(el, state){
    el.style.left   = state.left + 'px';
    el.style.top    = state.top + 'px';
    el.style.right  = 'auto';
    el.style.width  = state.width + 'px';
    el.style.height = state.height + 'px';
  }
  function clampToViewport(state){
    const maxW = window.innerWidth, maxH = window.innerHeight;
    const state2 = {
      width:  clamp(state.width,  MIN_W, maxW),
      height: clamp(state.height, MIN_H, maxH),
      left: state.left,
      top:  state.top
    };
    state2.left = clamp(state2.left, -(state2.width - 80), maxW - 80);
    state2.top  = clamp(state2.top, 0, maxH - 40);
    return state2;
  }

  WINDOWS.forEach(win => {
    const el = win.el;
    if(!el) return;

    if(!isMobile()){
      const saved = loadState(win.key);
      if(saved) applyState(el, clampToViewport(saved));
    }

    /* Персистим размер при ресайзе за угол (native CSS resize) + пересчёт канваса графика */
    let resizeRaf = null;
    const ro = new ResizeObserver(() => {
      if(isMobile()) return;
      window.dispatchEvent(new Event('resize'));
      if(resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => saveState(win.key, currentState(el)));
    });
    ro.observe(el);

    /* Перетаскивание за шапку */
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

    const header = el.querySelector(win.header);
    if(header){
      header.addEventListener('mousedown', (e)=>{
        if(isMobile()) return;
        if(e.button !== 0) return;
        if(e.target.closest('button, input, select, textarea, a')) return;

        const rect = el.getBoundingClientRect();
        applyState(el, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });

        dragging = true;
        startX = e.clientX; startY = e.clientY;
        startLeft = rect.left; startTop = rect.top;
        el.style.zIndex = 50;
        document.body.classList.add('dragging-window');
        e.preventDefault();
      });
    }

    window.addEventListener('mousemove', (e)=>{
      if(!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const rect = el.getBoundingClientRect();
      const newLeft = clamp(startLeft + dx, -(rect.width - 80), window.innerWidth - 80);
      const newTop  = clamp(startTop + dy, 0, window.innerHeight - 40);
      el.style.left = newLeft + 'px';
      el.style.top  = newTop + 'px';
    });

    window.addEventListener('mouseup', ()=>{
      if(!dragging) return;
      dragging = false;
      el.style.zIndex = '';
      document.body.classList.remove('dragging-window');
      saveState(win.key, currentState(el));
    });
  });

  /* Держим окна в границах, если сам браузер меняет размер */
  window.addEventListener('resize', ()=>{
    if(isMobile()) return;
    WINDOWS.forEach(win => {
      if(!win.el) return;
      applyState(win.el, clampToViewport(currentState(win.el)));
    });
  });
})();