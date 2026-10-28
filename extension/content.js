const button = document.createElement('button');
button.type = 'button';
button.setAttribute('aria-label', 'Download with PIDM');
button.style.cssText = 'all:initial;position:fixed;z-index:2147483647;display:none;padding:9px 12px;border-radius:8px;background:#1769df;color:#fff;font:600 13px Segoe UI,Arial,sans-serif;box-shadow:0 3px 14px #0005;cursor:pointer;max-width:230px;text-align:center';
document.documentElement.append(button);

let selectedElement = null;
let selectedUrl = null;
let isMedia = false;
let feedbackTimer = null;

function directUrl(element) {
  const candidates = element instanceof HTMLAnchorElement
    ? [element.href]
    : [element.currentSrc, element.src, element.querySelector('source[src]')?.src];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate, document.baseURI);
      if (['http:', 'https:'].includes(url.protocol)) return url.href;
    } catch {}
  }
  return null;
}

function videoPageUrl(element) {
  const page = new URL(document.location.href);
  const youtube = page.hostname === 'youtube.com' || page.hostname.endsWith('.youtube.com');
  if (!youtube) return page.href;
  // Preview players can live on the homepage or beside a different video.
  const container = element.closest('ytd-video-preview,ytd-rich-item-renderer,ytd-video-renderer,ytd-compact-video-renderer');
  const link = element.closest('a[href]') || container?.querySelector('a[href*="/watch?"],a[href*="/shorts/"]');
  for (const candidate of [link?.href, page.href]) {
    if (!candidate) continue;
    const url = new URL(candidate, page);
    if (url.hostname !== 'youtube.com' && !url.hostname.endsWith('.youtube.com')) continue;
    if ((url.pathname === '/watch' && url.searchParams.get('v')) || /^\/(shorts|embed|live)\/[^/]+/.test(url.pathname)) return url.href;
  }
  return null;
}

function positionButton() {
  if (!selectedElement?.isConnected) {
    button.style.display = 'none';
    return;
  }
  const bounds = selectedElement.getBoundingClientRect();
  if (bounds.bottom < 0 || bounds.top > innerHeight || bounds.right < 0 || bounds.left > innerWidth) {
    button.style.display = 'none';
    return;
  }
  const width = button.offsetWidth;
  const height = button.offsetHeight;
  button.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, bounds.right - width - 8))}px`;
  button.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, isMedia ? bounds.top + 8 : bounds.bottom + 5))}px`;
}

document.addEventListener('pointerover', event => {
  if (button.contains(event.target)) return;
  clearTimeout(feedbackTimer);
  const target = event.target instanceof Element ? event.target : null;
  const media = target?.closest('video,audio') || [...document.querySelectorAll('video,audio')].find(candidate => {
    const bounds = candidate.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
  });
  const element = media || target?.closest('a[href]');
  if (!element) {
    button.style.display = 'none';
    selectedElement = null;
    return;
  }
  selectedElement = element;
  isMedia = element instanceof HTMLMediaElement;
  selectedUrl = isMedia ? videoPageUrl(element) : directUrl(element);
  button.textContent = selectedUrl ? (isMedia ? '↓ Download this video' : '↓ Download this link') : 'Open this video first';
  button.style.background = selectedUrl ? '#1769df' : '#555c6a';
  button.style.display = 'block';
  positionButton();
}, true);

button.addEventListener('click', async event => {
  event.preventDefault();
  event.stopPropagation();
  // YouTube changes the page without reloading the script. Resolve at click time.
  selectedUrl = isMedia ? videoPageUrl(selectedElement) : directUrl(selectedElement);
  if (!selectedUrl) {
    button.textContent = 'Open this video first';
    return;
  }
  button.disabled = true;
  button.textContent = 'Adding download…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'download-url', url: selectedUrl, mode: isMedia ? 'video' : 'auto', mediaUrl: isMedia ? directUrl(selectedElement) : undefined, userAgent: navigator.userAgent });
    button.textContent = result?.selecting ? 'Choose quality in the new tab' : result?.ok ? '✓ Added to downloader' : result?.error || 'Could not add download';
    button.style.background = result?.ok ? '#258451' : '#b84242';
  } catch (error) {
    button.textContent = 'Could not reach the extension';
    button.style.background = '#b84242';
  } finally {
    button.disabled = false;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => { button.style.display = 'none'; }, 3000);
  }
});

document.addEventListener('scroll', positionButton, true);
window.addEventListener('resize', positionButton);
