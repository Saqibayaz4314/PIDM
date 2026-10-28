(() => {
  const saved = (() => { try { return localStorage.getItem('pidm-theme'); } catch { return null; } })();
  const system = matchMedia('(prefers-color-scheme: dark)');
  const apply = theme => {
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme)));
  };
  apply(saved === 'light' || saved === 'dark' ? saved : system.matches ? 'dark' : 'light');
  document.addEventListener('DOMContentLoaded', () => {
    apply(document.documentElement.dataset.theme);
    document.querySelectorAll('[data-theme-choice]').forEach(button => button.addEventListener('click', () => {
      apply(button.dataset.themeChoice);
      try { localStorage.setItem('pidm-theme', button.dataset.themeChoice); } catch {}
    }));
  });
})();
