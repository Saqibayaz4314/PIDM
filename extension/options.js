import { connect } from './connection.js';
const status = document.querySelector('#status');
const retry = document.querySelector('#reconnect');
async function checkConnection() {
  retry.disabled = true;
  status.textContent = 'Connecting to PIDM…';
  try { await connect(); status.textContent = 'Connected. Use the PIDM toolbar icon or the download button over a video.'; retry.textContent = 'Check connection'; }
  catch (error) { status.textContent = error.message; }
  finally { retry.disabled = false; }
}
retry.addEventListener('click', () => { void checkConnection(); });
await checkConnection();
