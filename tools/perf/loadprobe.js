// Load-time probe, injected before any page script (chrome-devtools MCP
// navigate_page({ initScript: <this file's text> }), or a DevTools snippet on
// reload). Records, relative to navigation start:
//   firstFrame  first requestAnimationFrame callback after the WebGPU/WebGL
//               canvas context exists (the first rendered frame)
//   bootDone    the boot loader starts fading (#boot gets .done): the UI has
//               seen steady frames, i.e. title (or, with ?mission=, the sortie)
//               is on screen and interactive
// Read with: JSON.stringify(window.__load)
(() => {
  const L = (window.__load = { firstFrame: null, bootDone: null, ctx: null });
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...a) {
    const c = gc.call(this, type, ...a);
    if (c && (type === 'webgpu' || type === 'webgl2') && this.id === 'viewport' && L.ctx === null) {
      L.ctx = performance.now();
      const raf = window.requestAnimationFrame.bind(window);
      const wait = () => raf(() => {
        // a frame counts once the game loop has submitted something
        if (L.firstFrame === null && (window.__ssBootFrames = (window.__ssBootFrames ?? 0) + 1) > 1) L.firstFrame = performance.now();
        if (L.firstFrame === null) wait();
      });
      wait();
    }
    return c;
  };
  const watch = () => {
    const boot = document.getElementById('boot');
    if (!boot) return void setTimeout(watch, 20);
    new MutationObserver(() => {
      if (L.bootDone === null && boot.classList.contains('done')) L.bootDone = performance.now();
    }).observe(boot, { attributes: true, attributeFilter: ['class'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();
})();
