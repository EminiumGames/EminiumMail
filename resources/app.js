const BACKEND_URL = 'http://127.0.0.1:6117'

const state = {
  bootstrap: null,
  selectedAccountId: null,
  selectedMessageId: null,
  selectedTab: 'html',
  backendProcessId: null,
  launcherPath: '',
  eventCursor: 0,
  pollTimer: null,
  eventTimer: null
}

const elements = {}

document.addEventListener('DOMContentLoaded', boot)

async function boot() {
  cacheElements()
  bindUi()
  await ensureRuntime()
  await loadLauncherPath()
  await ensureBackend()
  await refreshAll()
  startPolling()
}

function cacheElements() {
  const selectors = {
    backendDot: '#backend-dot',
    backendLabel: '#backend-label',
    backendDetail: '#backend-detail',
    accountList: '#account-list',
    accountFilter: '#account-filter',
    messageList: '#message-list',
    messageEmpty: '#message-empty',
    messageView: '#message-view',
    viewTitle: '#view-title',
    statUnread: '#stat-unread',
    statAccounts: '#stat-accounts',
    statNew: '#stat-new',
    messageSubject: '#message-subject',
    messageFrom: '#message-from',
    messageDate: '#message-date',
    messageAccount: '#message-account',
    messageTags: '#message-tags',
    messageHtml: '#message-html',
    messageText: '#message-text',
    refreshBtn: '#refresh-btn',
    addAccountBtn: '#add-account-btn',
    startupBtn: '#startup-btn',
    syncAllBtn: '#sync-all-btn',
    accountDialog: '#account-dialog',
    accountForm: '#account-form',
    accountFormTitle: '#account-form-title',
    closeDialogBtn: '#close-dialog-btn',
    testAccountBtn: '#test-account-btn',
    accountId: '#account-id',
    accountLabel: '#account-label',
    accountHost: '#account-host',
    accountPort: '#account-port',
    accountEncryption: '#account-encryption',
    accountUsername: '#account-username',
    accountPassword: '#account-password',
    accountFolder: '#account-folder',
    accountInterval: '#account-interval'
  }

  for (const [key, selector] of Object.entries(selectors)) {
    elements[key] = document.querySelector(selector)
  }
}

function bindUi() {
  elements.refreshBtn.addEventListener('click', refreshAll)
  elements.addAccountBtn.addEventListener('click', () => openAccountDialog())
  elements.startupBtn.addEventListener('click', toggleStartup)
  elements.syncAllBtn.addEventListener('click', syncAllAccounts)
  elements.closeDialogBtn.addEventListener('click', () => elements.accountDialog.close())
  elements.accountForm.addEventListener('submit', saveAccount)
  elements.testAccountBtn.addEventListener('click', testAccountFromForm)
  elements.accountFilter.addEventListener('change', () => {
    state.selectedAccountId = elements.accountFilter.value || null
    renderMessages()
    renderSelectedMessage()
  })

  document.querySelectorAll('[data-body-tab]').forEach((button) => {
    button.addEventListener('click', () => switchMessageTab(button.dataset.bodyTab))
  })
}

async function ensureRuntime() {
  if (window.Neutralino?.init) {
    try {
      await Neutralino.init()
    } catch (error) {
      console.warn(error)
    }
  }
}

async function loadLauncherPath() {
  if (!window.Neutralino?.os?.execCommand) {
    return
  }

  try {
    const result = await Neutralino.os.execCommand(
      'powershell -NoProfile -Command "[System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName"'
    )
    state.launcherPath = (result.stdOut || '').trim()
  } catch (error) {
    state.launcherPath = ''
  }
}

async function ensureBackend() {
  if (await checkBackend()) {
    updateBackendUi(true, 'Backend actif', 'Service local pret')
    return
  }

  updateBackendUi(false, 'Lancement du backend', 'Demarrage du service local')

  if (window.Neutralino?.os?.spawnProcess) {
    try {
      const backendScriptPath = normalizePath(joinPath(getAppPath(), 'backend', 'mail_service.py'))
      const command = `py -3 "${backendScriptPath}" --host 127.0.0.1 --port 6117`
      const processInfo = await Neutralino.os.spawnProcess(command, { cwd: getAppPath() })
      state.backendProcessId = processInfo.id
    } catch (error) {
      console.warn(error)
    }
  }

  await waitForBackend()
}

async function waitForBackend() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await checkBackend()) {
      updateBackendUi(true, 'Backend actif', 'Service local pret')
      return
    }

    await pause(500)
  }

  updateBackendUi(false, 'Backend indisponible', 'Installe Python ou lance le service manuellement')
}

async function checkBackend() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/health`)
    return response.ok
  } catch (error) {
    return false
  }
}

function updateBackendUi(online, label, detail) {
  elements.backendDot.classList.toggle('online', online)
  elements.backendLabel.textContent = label
  elements.backendDetail.textContent = detail
  elements.startupBtn.disabled = !state.launcherPath
  const isEnabled = state.bootstrap?.settings?.autostartEnabled ?? false
  elements.startupBtn.textContent = state.launcherPath
    ? isEnabled
      ? 'Desactiver le demarrage automatique'
      : 'Activer le demarrage automatique'
    : 'Demarrage auto indisponible'
}

async function refreshAll() {
  if (!(await checkBackend())) {
    return
  }

  const bootstrap = await fetchJson('/api/bootstrap')
  state.bootstrap = bootstrap
  state.eventCursor = Math.max(state.eventCursor, ...(bootstrap.events || []).map((event) => event.id || 0), 0)

  if (!state.selectedAccountId && bootstrap.accounts.length) {
    state.selectedAccountId = bootstrap.accounts[0].id
  }

  elements.statAccounts.textContent = String(bootstrap.accounts.length)
  elements.statUnread.textContent = String(bootstrap.messages.filter((message) => !message.read).length)
  elements.statNew.textContent = String(bootstrap.events.filter((event) => event.type === 'new_message').length)

  renderAccounts()
  renderAccountFilter()
  renderMessages()
  renderSelectedMessage()
  updateBackendUi(true, 'Backend actif', 'Service local pret')
}

function renderAccounts() {
  const accounts = state.bootstrap?.accounts || []
  elements.accountList.innerHTML = accounts.length
    ? accounts.map((account) => accountCardTemplate(account)).join('')
    : `<div class="empty-state"><h3>Aucun compte</h3><p>Ajoute ta premiere boite mail pour commencer a recevoir les alertes.</p></div>`

  elements.accountList.querySelectorAll('[data-account-id]').forEach((node) => {
    node.addEventListener('click', () => {
      state.selectedAccountId = node.dataset.accountId
      elements.accountFilter.value = state.selectedAccountId
      renderMessages()
      renderSelectedMessage()
    })
  })

  elements.accountList.querySelectorAll('[data-edit-account]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      openAccountDialog(accounts.find((account) => account.id === button.dataset.editAccount))
    })
  })

  elements.accountList.querySelectorAll('[data-delete-account]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation()
      await deleteAccount(button.dataset.deleteAccount)
    })
  })

  elements.accountList.querySelectorAll('[data-sync-account]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation()
      await syncAccount(button.dataset.syncAccount)
    })
  })
}

function renderAccountFilter() {
  const accounts = state.bootstrap?.accounts || []
  const options = [`<option value="">Tous les comptes</option>`]
  for (const account of accounts) {
    options.push(`<option value="${escapeHtml(account.id)}">${escapeHtml(account.label)}</option>`)
  }

  elements.accountFilter.innerHTML = options.join('')
  elements.accountFilter.value = state.selectedAccountId || ''
}

function renderMessages() {
  const accounts = state.bootstrap?.accounts || []
  const messages = state.bootstrap?.messages || []
  const filteredMessages = messages
    .filter((message) => !state.selectedAccountId || message.accountId === state.selectedAccountId)
    .sort((left, right) => right.sortKey - left.sortKey)

  const activeAccount = accounts.find((account) => account.id === state.selectedAccountId)
  elements.viewTitle.textContent = activeAccount ? `Flux ${activeAccount.label}` : 'Tous les messages'

  elements.messageList.innerHTML = filteredMessages.length
    ? filteredMessages.map((message) => messageCardTemplate(message, accounts)).join('')
    : `<div class="empty-state"><h3>Flux vide</h3><p>Aucun message ne correspond au filtre actuel.</p></div>`

  elements.messageList.querySelectorAll('[data-message-id]').forEach((node) => {
    node.addEventListener('click', () => openMessage(node.dataset.messageId))
  })

  elements.messageList.querySelectorAll('[data-mark-read]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation()
      await markMessageRead(button.dataset.markRead)
    })
  })
}

function renderSelectedMessage() {
  const message = state.bootstrap?.messages.find((entry) => entry.id === state.selectedMessageId)
  if (!message) {
    elements.messageEmpty.classList.remove('hidden')
    elements.messageView.classList.add('hidden')
    return
  }

  const account = state.bootstrap.accounts.find((entry) => entry.id === message.accountId)
  elements.messageEmpty.classList.add('hidden')
  elements.messageView.classList.remove('hidden')
  elements.messageSubject.textContent = message.subject || 'Sans sujet'
  elements.messageFrom.textContent = message.from || 'Inconnu'
  elements.messageDate.textContent = message.date || 'Date inconnue'
  elements.messageAccount.textContent = account ? account.label : message.accountLabel
  elements.messageTags.innerHTML = [
    message.read ? `<span class="pill">Lu</span>` : `<span class="pill warn">Non lu</span>`,
    message.hasHtml ? `<span class="pill">HTML</span>` : `<span class="pill">Texte brut</span>`
  ].join('')
  elements.messageHtml.srcdoc = sanitizeHtml(message.bodyHtml || `<pre>${escapeHtml(message.bodyText || '')}</pre>`)
  elements.messageText.textContent = message.bodyText || ''
  switchMessageTab(state.selectedTab)
}

function switchMessageTab(tab) {
  state.selectedTab = tab
  document.querySelectorAll('[data-body-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.bodyTab === tab)
  })
  elements.messageHtml.classList.toggle('hidden', tab !== 'html')
  elements.messageText.classList.toggle('hidden', tab !== 'text')
}

async function openAccountDialog(account = null) {
  elements.accountFormTitle.textContent = account ? 'Modifier le compte' : 'Ajouter un compte'
  elements.accountId.value = account?.id || ''
  elements.accountLabel.value = account?.label || ''
  elements.accountHost.value = account?.host || ''
  elements.accountPort.value = account?.port || 993
  elements.accountEncryption.value = account?.encryption || 'ssl'
  elements.accountUsername.value = account?.username || ''
  elements.accountPassword.value = ''
  elements.accountFolder.value = account?.folder || 'INBOX'
  elements.accountInterval.value = account?.pollInterval || 60
  elements.accountDialog.showModal()
}

async function saveAccount(event) {
  event.preventDefault()
  const payload = {
    id: elements.accountId.value || undefined,
    label: elements.accountLabel.value.trim(),
    host: elements.accountHost.value.trim(),
    port: Number(elements.accountPort.value),
    encryption: elements.accountEncryption.value,
    username: elements.accountUsername.value.trim(),
    password: elements.accountPassword.value,
    folder: elements.accountFolder.value.trim() || 'INBOX',
    pollInterval: Number(elements.accountInterval.value)
  }

  await fetchJson('/api/accounts', {
    method: 'POST',
    body: JSON.stringify(payload)
  })

  elements.accountDialog.close()
  await refreshAll()
}

async function testAccountFromForm() {
  const payload = {
    host: elements.accountHost.value.trim(),
    port: Number(elements.accountPort.value),
    encryption: elements.accountEncryption.value,
    username: elements.accountUsername.value.trim(),
    password: elements.accountPassword.value,
    folder: elements.accountFolder.value.trim() || 'INBOX'
  }

  const result = await fetchJson('/api/test-account', {
    method: 'POST',
    body: JSON.stringify(payload)
  })

  await notify(result.ok ? 'Connexion OK' : 'Connexion refusee', result.message, result.ok ? 'INFO' : 'ERROR')
}

async function deleteAccount(accountId) {
  await fetchJson(`/api/accounts/${encodeURIComponent(accountId)}`, {
    method: 'DELETE'
  })
  if (state.selectedAccountId === accountId) {
    state.selectedAccountId = null
  }
  await refreshAll()
}

async function syncAccount(accountId) {
  await fetchJson(`/api/accounts/${encodeURIComponent(accountId)}/sync`, { method: 'POST' })
  await refreshAll()
}

async function syncAllAccounts() {
  const accounts = state.bootstrap?.accounts || []
  for (const account of accounts) {
    await syncAccount(account.id)
  }
}

async function toggleStartup() {
  if (!state.launcherPath) {
    return
  }

  const enabled = !(state.bootstrap?.settings?.autostartEnabled ?? false)
  const result = await fetchJson('/api/startup', {
    method: 'POST',
    body: JSON.stringify({ enabled, launcherPath: state.launcherPath })
  })

  if (result.ok) {
    await refreshAll()
  }
}

async function markMessageRead(messageId) {
  await fetchJson(`/api/messages/${encodeURIComponent(messageId)}/read`, {
    method: 'POST',
    body: JSON.stringify({ read: true })
  })
  await refreshAll()
}

async function syncEvents() {
  if (!(await checkBackend())) {
    return
  }

  const result = await fetchJson(`/api/events?after=${state.eventCursor}`)
  for (const event of result.events || []) {
    state.eventCursor = Math.max(state.eventCursor, event.id || 0)
    if (event.type === 'new_message') {
      await notify(event.title || 'Nouveau mail', event.message || 'Un nouveau message est arrive.', 'INFO')
    }
  }
  if ((result.events || []).length) {
    await refreshAll()
  }
}

async function notify(title, content, icon = 'INFO') {
  if (window.Neutralino?.os?.showNotification) {
    await Neutralino.os.showNotification(title, content, icon)
    return
  }
  console.log(title, content, icon)
}

async function openMessage(messageId) {
  state.selectedMessageId = messageId
  await markMessageRead(messageId)
  renderSelectedMessage()
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.message || `HTTP ${response.status}`)
  }
  return data
}

function accountCardTemplate(account) {
  const unread = account.unreadCount || 0
  const lastSync = account.lastSyncAt || 'Jamais'
  return `
    <article class="account-card ${state.selectedAccountId === account.id ? 'active' : ''}" data-account-id="${escapeHtml(account.id)}">
      <div class="account-head">
        <div>
          <h4>${escapeHtml(account.label)}</h4>
          <div class="account-meta">${escapeHtml(account.username)}<br>${escapeHtml(account.host)}:${escapeHtml(String(account.port))}</div>
        </div>
        <span class="pill ${account.lastError ? 'danger' : unread ? 'warn' : ''}">${account.lastError ? 'Erreur' : `${unread} non lus`}</span>
      </div>
      <div class="account-meta">Dossier ${escapeHtml(account.folder || 'INBOX')} - Sync ${escapeHtml(lastSync)}</div>
      <div class="dialog-actions" style="justify-content:flex-start; flex-wrap:wrap; margin-top:12px;">
        <button class="ghost" data-sync-account="${escapeHtml(account.id)}">Sync</button>
        <button class="ghost" data-edit-account="${escapeHtml(account.id)}">Editer</button>
        <button class="ghost" data-delete-account="${escapeHtml(account.id)}">Supprimer</button>
      </div>
    </article>
  `
}

function messageCardTemplate(message, accounts) {
  const account = accounts.find((entry) => entry.id === message.accountId)
  return `
    <article class="message-card ${message.read ? '' : 'unread'} ${state.selectedMessageId === message.id ? 'active' : ''}" data-message-id="${escapeHtml(message.id)}">
      <div class="message-head">
        <div>
          <h4>${escapeHtml(message.from || 'Inconnu')}</h4>
          <div class="message-meta-small">${escapeHtml(account ? account.label : message.accountLabel || 'Compte inconnu')}</div>
        </div>
        <span class="pill ${message.read ? '' : 'warn'}">${message.read ? 'Lu' : 'Non lu'}</span>
      </div>
      <div class="subject">${escapeHtml(message.subject || 'Sans sujet')}</div>
      <div class="snippet">${escapeHtml(message.snippet || message.bodyText || '')}</div>
      <div class="dialog-actions" style="justify-content:flex-start; flex-wrap:wrap; margin-top:12px;">
        <button class="ghost" data-mark-read="${escapeHtml(message.id)}">Marquer lu</button>
      </div>
    </article>
  `
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function sanitizeHtml(html) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html || '', 'text/html')
  doc.querySelectorAll('script, iframe, object, embed, link, meta').forEach((node) => node.remove())
  doc.querySelectorAll('*').forEach((node) => {
    for (const attribute of [...node.attributes]) {
      if (attribute.name.startsWith('on')) {
        node.removeAttribute(attribute.name)
      }
    }
  })
  return doc.documentElement.outerHTML
}

function getAppPath() {
  return (window.NL_PATH || '.').replaceAll('\\', '/')
}

function joinPath(...parts) {
  return parts.join('/').replaceAll('//', '/')
}

function normalizePath(path) {
  return path.replaceAll('/', '\\')
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function startPolling() {
  clearInterval(state.pollTimer)
  clearInterval(state.eventTimer)
  state.pollTimer = setInterval(refreshAll, 30000)
  state.eventTimer = setInterval(syncEvents, 15000)
}
