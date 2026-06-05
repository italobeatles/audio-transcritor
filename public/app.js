const audioInput = document.getElementById('audioInput');
const chooseFileBtn = document.getElementById('chooseFileBtn');
const dropZone = document.getElementById('dropZone');
const fileName = document.getElementById('fileName');
const transcript = document.getElementById('transcript');
const context = document.getElementById('context');
const answer = document.getElementById('answer');
const transcribeBtn = document.getElementById('transcribeBtn');
const generateBtn = document.getElementById('generateBtn');
const copyBtn = document.getElementById('copyBtn');
const statusPill = document.getElementById('statusPill');
const refreshProvidersBtn = document.getElementById('refreshProvidersBtn');
const providersGrid = document.getElementById('providersGrid');
const providersMeta = document.getElementById('providersMeta');

let selectedFile = null;

function setStatus(text) {
  statusPill.textContent = text;
}

function setFile(file) {
  selectedFile = file;
  fileName.textContent = file ? file.name : 'Nenhum arquivo selecionado';
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.dataset.original = button.dataset.original || button.textContent;
  button.textContent = busy ? label : button.dataset.original;
}

function providerBadgeClass(status) {
  if (status === 'available') return 'badge-ok';
  if (status === 'missing_key') return 'badge-missing';
  return 'badge-off';
}

function providerStatusLabel(status) {
  if (status === 'available') return 'Online';
  if (status === 'missing_key') return 'Sem chave';
  if (status === 'quota_exhausted') return 'Sem cota';
  return 'Offline';
}

function renderProviders(providers = [], checkedAt) {
  providersGrid.innerHTML = providers.map(provider => `
    <article class="provider-card">
      <div class="provider-head">
        <div>
          <div class="provider-name">${provider.providerName}</div>
          <div class="provider-model">${provider.modelName}</div>
        </div>
        <div class="provider-badge ${providerBadgeClass(provider.status)}">${providerStatusLabel(provider.status)}</div>
      </div>
      <div class="provider-error">${provider.lastError || 'Conexão verificada.'}</div>
      <div class="provider-foot">
        <span>${provider.enabled ? 'Habilitado' : 'Desabilitado'}</span>
        <span>${provider.localFallback ? 'Fallback local' : (provider.keyPresent ? 'Chave configurada' : 'Chave ausente')}</span>
      </div>
    </article>
  `).join('');
  providersMeta.textContent = checkedAt ? `Atualizado em ${new Date(checkedAt).toLocaleString('pt-BR')}` : 'Verificação pendente';
}

async function loadProviders() {
  setStatus('Verificando providers');
  const response = await fetch('/api/providers');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Falha ao verificar providers');
  renderProviders(data.providers || [], data.checkedAt);
  setStatus('Providers atualizados');
}

chooseFileBtn.addEventListener('click', () => audioInput.click());
dropZone.addEventListener('click', () => audioInput.click());
refreshProvidersBtn.addEventListener('click', async () => {
  refreshProvidersBtn.disabled = true;
  try {
    await loadProviders();
  } catch (error) {
    setStatus('Erro ao verificar providers');
    providersMeta.textContent = error.message;
  } finally {
    refreshProvidersBtn.disabled = false;
  }
});

audioInput.addEventListener('change', () => setFile(audioInput.files?.[0] || null));

['dragenter', 'dragover'].forEach(eventName => {
  dropZone.addEventListener(eventName, e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach(eventName => {
  dropZone.addEventListener(eventName, e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  });
});

dropZone.addEventListener('drop', e => {
  const file = e.dataTransfer.files?.[0];
  if (file) {
    audioInput.files = e.dataTransfer.files;
    setFile(file);
  }
});

transcribeBtn.addEventListener('click', async () => {
  if (!selectedFile) {
    setStatus('Selecione um áudio');
    return;
  }

  setBusy(transcribeBtn, true, 'Transcrevendo...');
  setStatus('Transcrevendo');
  try {
    const formData = new FormData();
    formData.append('audio', selectedFile);
    const response = await fetch('/api/transcribe', { method: 'POST', body: formData });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha na transcrição');
    transcript.value = data.text || '';
    setStatus('Transcrição pronta');
  } catch (error) {
    setStatus('Erro na transcrição');
    transcript.value = `Erro: ${error.message}`;
  } finally {
    setBusy(transcribeBtn, false);
  }
});

generateBtn.addEventListener('click', async () => {
  if (!transcript.value.trim()) {
    setStatus('Transcreva antes');
    return;
  }

  setBusy(generateBtn, true, 'Gerando...');
  setStatus('Gerando resposta');
  try {
    const response = await fetch('/api/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: transcript.value,
        userContext: context.value
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao gerar resposta');
    answer.value = data.text || '';
    setStatus('Resposta pronta');
  } catch (error) {
    setStatus('Erro na resposta');
    answer.value = `Erro: ${error.message}`;
  } finally {
    setBusy(generateBtn, false);
  }
});

copyBtn.addEventListener('click', async () => {
  if (!answer.value.trim()) return;
  await navigator.clipboard.writeText(answer.value);
  setStatus('Resposta copiada');
});

loadProviders().catch(error => {
  providersMeta.textContent = error.message;
});
