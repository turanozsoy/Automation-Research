const $ = (s) => document.querySelector(s);

chrome.storage.sync.get({ serviceUrl: 'http://localhost:3000', token: '' }, (s) => {
  $('#serviceUrl').value = s.serviceUrl;
  $('#token').value = s.token;
});

$('#save').onclick = () => {
  const serviceUrl = $('#serviceUrl').value.trim().replace(/\/+$/, '') || 'http://localhost:3000';
  const token = $('#token').value.trim();
  chrome.storage.sync.set({ serviceUrl, token }, () => {
    $('#saved').textContent = 'saved';
    setTimeout(() => { $('#saved').textContent = ''; }, 1500);
  });
};
