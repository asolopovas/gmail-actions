<script setup lang="ts">
import { onMounted, ref, watch } from "vue"
import { STORAGE_KEYS, useGmailAuth } from "../composables/useGmailAuth"

interface GmailMessage {
    id: string
    threadId: string
    subject: string
    from: string
    to: string
    date: string
    body: string
    fullBody: string
    accountEmail: string
}

const searchQuery = ref("label:inbox newer_than:7d")
const searchScope = ref("anywhere")
const messages = ref<GmailMessage[]>([])
const selectedMessage = ref<GmailMessage | null>(null)
const loadingSearch = ref(false)

const {
    clientId,
    googleScriptLoaded,
    gisScriptLoaded,
    gapiReady,
    accounts,
    selectedAccounts,
    isSignedIn,
    statusText,
    statusType,
    loadingAuthorize,
    readyForSearch,
    authorizeAccount,
    removeAccount,
    requestAccessToken,
    addOrUpdateAccount,
    normalizeError,
    setStatus,
    logInfo,
    logWarn,
    logError,
    logDebug,
} = useGmailAuth()

const scopeLookup: Record<string, string> = {
    anywhere: "",
    inbox: "in:inbox",
    sent: "in:sent",
    draft: "in:drafts",
    spam: "in:spam",
    trash: "in:trash",
    starred: "is:starred",
}

const parseHeader = (
    headers: Array<{ name: string; value: string }> | undefined,
    name: string
) => headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? ""

const formatDate = (input: string) => {
    if (!input) return "Unknown date"
    const date = new Date(input)
    if (Number.isNaN(date.getTime())) {
        return input
    }

    const pad = (val: number) => val.toString().padStart(2, "0")
    const dd = pad(date.getDate())
    const mm = pad(date.getMonth() + 1)
    const yyyy = date.getFullYear()
    const hh = pad(date.getHours())
    const min = pad(date.getMinutes())
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`
}

const makeExcerpt = (text: string, limit = 220) => {
    const normalized = text.replace(/\s+/g, " ").trim()
    if (!normalized) return ""
    if (normalized.length <= limit) return normalized
    return `${normalized.slice(0, limit)}…`
}

const extractPlainBody = (payload: any): string => {
    if (!payload) {
        return ""
    }

    const mimeType = payload.mimeType || ""
    if (payload.body?.data && mimeType.startsWith("text/plain")) {
        try {
            return atob(payload.body.data.replace(/-/g, "+").replace(/_/g, "/"))
        } catch {
            return ""
        }
    }

    if (Array.isArray(payload.parts)) {
        for (const part of payload.parts) {
            const text = extractPlainBody(part)
            if (text) {
                return text
            }
        }
    }

    return ""
}

const restoreSearchPreferences = () => {
    if (typeof window === "undefined") return
    try {
        const storedQuery = localStorage.getItem(STORAGE_KEYS.searchQuery)
        if (storedQuery) {
            searchQuery.value = storedQuery
        }
        const storedScope = localStorage.getItem(STORAGE_KEYS.searchScope)
        if (storedScope) {
            searchScope.value = storedScope
        }
        logDebug("Restored search preferences", {
            hasQuery: Boolean(searchQuery.value),
            scope: searchScope.value,
        })
    } catch (error) {
        logWarn("Unable to restore search preferences", { error })
    }
}

onMounted(() => {
    restoreSearchPreferences()
})

if (typeof window !== "undefined") {
    watch(searchQuery, (value) => {
        localStorage.setItem(STORAGE_KEYS.searchQuery, value)
    })
    watch(searchScope, (value) => {
        localStorage.setItem(STORAGE_KEYS.searchScope, value)
    })
}

const openMessage = (message: GmailMessage) => {
    selectedMessage.value = message
}

const closeModal = () => {
    selectedMessage.value = null
}

const searchMailbox = async () => {
    if (!readyForSearch.value) {
        setStatus("Authorize Gmail before searching.", "error")
        return
    }

    if (!searchQuery.value.trim()) {
        setStatus("Enter a Gmail search query.", "error")
        return
    }

    const targets = selectedAccounts.value.length ? selectedAccounts.value : accounts.value.map((a) => a.email)
    if (!targets.length) {
        setStatus("Authorize at least one account before searching.", "error")
        return
    }

    const scopeClause = scopeLookup[searchScope.value] ?? ""
    const effectiveQuery = [scopeClause, searchQuery.value.trim()].filter(Boolean).join(" ").trim()

    loadingSearch.value = true
    setStatus("Contacting Gmail...", "info")
    logInfo("Searching Gmail mailbox", { query: effectiveQuery, accounts: targets })
    selectedMessage.value = null

    try {
        const gapi = window.gapi
        const aggregated: GmailMessage[] = []

        for (const email of targets) {
            const account = accounts.value.find((a) => a.email === email)
            if (!account) {
                logWarn("Skipping missing account", { email })
                continue
            }

            if (!account.token) {
                logWarn("Account missing token; requesting consent", { email })
                try {
                    const token = await requestAccessToken({ promptMode: "consent", hint: account.email })
                    addOrUpdateAccount(account.email, token)
                } catch (error) {
                    logError("Failed to refresh token for account", { email, error })
                    continue
                }
            }

            gapi.client.setToken({ access_token: account.token })

            const listResponse = await gapi.client.gmail.users.messages.list({
                userId: "me",
                q: effectiveQuery,
                maxResults: 10,
            })

            const candidateMessages = listResponse.result.messages ?? []
            if (!candidateMessages.length) {
                logInfo("No messages for account", { email })
                continue
            }

            const detailedMessages = await Promise.all(
                candidateMessages.map(async (message: { id: string; threadId: string }) => {
                    const detail = await gapi.client.gmail.users.messages.get({
                        userId: "me",
                        id: message.id,
                        format: "full",
                    })

                    const headers = detail.result.payload?.headers ?? []
                    const bodyText = extractPlainBody(detail.result.payload)
                    const fullBody = bodyText || detail.result.snippet || ""
                    const rawDate = parseHeader(headers, "Date") || "Unknown date"
                    const result: GmailMessage = {
                        id: message.id,
                        threadId: message.threadId,
                        subject: parseHeader(headers, "Subject") || "(No subject)",
                        from: parseHeader(headers, "From") || "Unknown sender",
                        to: parseHeader(headers, "To") || "Unknown recipient",
                        date: formatDate(rawDate),
                        body: makeExcerpt(fullBody),
                        fullBody,
                        accountEmail: email,
                    }
                    return result
                })
            )

            aggregated.push(...detailedMessages)
        }

        messages.value = aggregated

        if (!aggregated.length) {
            setStatus("No messages matched your query.", "info")
            return
        }

        setStatus(
            `Fetched ${aggregated.length} message${aggregated.length === 1 ? "" : "s"} from ${
                targets.length
            } account${targets.length === 1 ? "" : "s"}.`,
            "success"
        )
        logInfo("Fetched Gmail messages", { count: aggregated.length, accounts: targets.length })
    } catch (error) {
        logError("Gmail search failed", { error })
        setStatus(normalizeError(error, "Unable to search Gmail."), "error")
    } finally {
        loadingSearch.value = false
    }
}
</script>

<template>
    <div class="app-shell">
        <main class="gmail-card">
            <header class="gmail-card__header">
                <p class="eyebrow">Gmail actions</p>
                <h1>Search Gmail across multiple accounts</h1>
            <p class="lede">Connect multiple Gmail accounts, choose which inboxes to include, and review matches quickly.</p>
            </header>

            <div
                class="status-bar"
                :class="`status-bar--${statusType}`"
            >
                <span>{{ statusText }}</span>
            </div>

            <section class="panel">
                <div class="panel__title">
                    <h2>Search inboxes</h2>
                    <p>Run Gmail queries across all authorized accounts.</p>
                </div>

                <form
                    class="search"
                    @submit.prevent="searchMailbox"
                >
                    <label class="form-field">
                        <span>Search query</span>
                        <input
                            v-model="searchQuery"
                            type="text"
                            name="search"
                            autocomplete="off"
                            placeholder='subject:"weekly report" newer_than:7d'
                            :disabled="!readyForSearch"
                        />
                    </label>

                    <label class="form-field">
                        <span>Folder / scope</span>
                        <select
                            v-model="searchScope"
                            :disabled="!readyForSearch"
                        >
                            <option value="anywhere">All mail</option>
                            <option value="inbox">Inbox</option>
                            <option value="sent">Sent</option>
                            <option value="draft">Drafts</option>
                            <option value="spam">Spam</option>
                            <option value="trash">Trash</option>
                            <option value="starred">Starred</option>
                        </select>
                    </label>

                    <div class="accounts">
                        <div class="accounts__header">
                            <div>
                                <p class="accounts__title">Authorized accounts</p>
                                <p class="accounts__subtitle">Select inboxes and manage tokens.</p>
                            </div>
                            <button
                                class="btn btn--ghost"
                                type="button"
                                :disabled="loadingAuthorize"
                                @click="authorizeAccount(undefined, { forcePrompt: true, forceSelectAccount: true })"
                            >
                                + Add account
                            </button>
                        </div>

                        <div
                            v-if="accounts.length"
                            class="accounts__list"
                        >
                            <div
                                v-for="account in accounts"
                                :key="account.email"
                                class="account-row"
                            >
                                <label class="account-row__main">
                                    <input
                                        v-model="selectedAccounts"
                                        type="checkbox"
                                        :value="account.email"
                                    />
                                    <div>
                                        <p class="account-row__email">{{ account.email }}</p>
                                        <p class="account-row__status">
                                            {{ account.token ? "Connected" : "Needs auth" }}
                                            <span v-if="account.needsConsent" class="pill pill--warn">Re-auth required</span>
                                        </p>
                                    </div>
                                </label>
                                <div class="account-row__actions">
                                    <button
                                        class="btn btn--ghost btn--tiny"
                                        type="button"
                                        :disabled="loadingAuthorize"
                                        @click="authorizeAccount(account.email)"
                                    >
                                        Refresh
                                    </button>
                                    <button
                                        class="btn btn--ghost btn--tiny btn--danger"
                                        type="button"
                                        @click="removeAccount(account.email)"
                                    >
                                        Remove
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div
                            v-else
                            class="placeholder"
                        >
                            No accounts yet. Add one to begin searching.
                        </div>
                    </div>

                    <div class="actions">
                        <button
                            class="btn"
                            type="submit"
                            :disabled="!readyForSearch || loadingSearch"
                        >
                            {{ loadingSearch ? "Searching…" : "Search inboxes" }}
                        </button>
                    </div>
                </form>

                <div
                    v-if="!isSignedIn"
                    class="placeholder"
                >
                    Authorize Gmail to enable search.
                </div>

                <div
                    v-else
                    class="results"
                >
                    <p
                        v-if="!messages.length && !loadingSearch"
                        class="placeholder"
                    >
                        No messages loaded yet.
                    </p>
                    <div v-else class="cards">
                        <article
                            v-for="message in messages"
                            :key="message.id"
                            class="email-card"
                        >
                            <header>
                                <div>
                                    <p class="email-card__subject">{{ message.subject }}</p>
                                    <p class="email-card__from">From: {{ message.from }}</p>
                                    <p class="email-card__to">To: {{ message.to }}</p>
                                </div>
                                <div class="email-card__meta">
                                    <span class="pill">{{ message.accountEmail }}</span>
                                    <p class="email-card__date">{{ message.date }}</p>
                                </div>
                            </header>
                            <p class="email-card__body">{{ message.body }}</p>
                            <div class="email-card__footer">
                                <button
                                    class="btn btn--ghost btn--tiny"
                                    type="button"
                                    @click="openMessage(message)"
                                >
                                    View message
                                </button>
                            </div>
                        </article>
                    </div>
                </div>
            </section>

            <section class="panel">
                <div class="panel__title">
                    <h2>Settings</h2>
                    <p>Provide your Web OAuth Client ID for Gmail.</p>
                </div>

                <div class="form-grid">
                    <label class="form-field">
                        <span>OAuth Client ID</span>
                        <input
                            v-model="clientId"
                            type="text"
                            name="client-id"
                            autocomplete="off"
                            placeholder="1234567890-example.apps.googleusercontent.com"
                        />
                    </label>
                </div>

                <ul class="status-list">
                    <li>
                        <span>Google script</span>
                        <strong>{{ googleScriptLoaded ? "Loaded" : "Not loaded" }}</strong>
                    </li>
                    <li>
                        <span>Identity script</span>
                        <strong>{{ gisScriptLoaded ? "Loaded" : "Not loaded" }}</strong>
                    </li>
                    <li>
                        <span>API client</span>
                        <strong>{{ gapiReady ? "Initialized" : "Not initialized" }}</strong>
                    </li>
                    <li>
                        <span>Accounts</span>
                        <strong>{{ accounts.length ? `${accounts.length} connected` : "None" }}</strong>
                    </li>
                </ul>
            </section>
        </main>

        <div
            v-if="selectedMessage"
            class="modal-overlay"
            @click.self="closeModal"
        >
            <div class="modal">
                <button
                    class="modal__close"
                    type="button"
                    @click="closeModal"
                    aria-label="Close"
                >
                    X
                </button>
                <p class="modal__eyebrow">Full message</p>
                <h3 class="modal__subject">{{ selectedMessage.subject }}</h3>
                <div class="modal__meta">
                    <span class="pill">{{ selectedMessage.accountEmail }}</span>
                    <span class="modal__date">{{ selectedMessage.date }}</span>
                </div>
                <p class="modal__from">From: {{ selectedMessage.from }}</p>
                <p class="modal__to">To: {{ selectedMessage.to }}</p>
                <div class="modal__body">
                    <p v-if="selectedMessage.fullBody">{{ selectedMessage.fullBody }}</p>
                    <p v-else class="modal__empty">No body content available.</p>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
    :global(body) {
        margin: 0;
        font-family: "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #0f172a;
    }

    .app-shell {
        min-height: 100vh;
        padding: 40px 16px 64px;
        background: radial-gradient(circle at 15% 20%, rgba(59, 130, 246, 0.25), transparent 45%),
            radial-gradient(circle at 85% 10%, rgba(236, 72, 153, 0.2), transparent 45%), #0f172a;
        color: #0f172a;
    }

    .gmail-card {
        max-width: 960px;
        margin: 0 auto;
        background: #fff;
        border-radius: 24px;
        box-shadow: 0 25px 60px rgba(15, 23, 42, 0.25);
        padding: 48px;
        display: flex;
        flex-direction: column;
        gap: 40px;
    }

    .gmail-card__header h1 {
        margin: 8px 0;
        font-size: clamp(1.75rem, 3vw, 2.5rem);
        color: #0f172a;
    }

    .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.2em;
        font-size: 0.75rem;
        color: #6366f1;
        font-weight: 600;
    }

    .lede {
        color: #475569;
        margin: 0;
        max-width: 48ch;
    }

    .status-bar {
        border-radius: 16px;
        padding: 16px 20px;
        font-weight: 500;
        border: 1px solid transparent;
    }

    .status-bar--info {
        background: #eef2ff;
        border-color: #c7d2fe;
        color: #4338ca;
    }

    .status-bar--success {
        background: #ecfdf5;
        border-color: #a7f3d0;
        color: #047857;
    }

    .status-bar--error {
        background: #fef2f2;
        border-color: #fecaca;
        color: #b91c1c;
    }

    .panel {
        border: 1px solid #e2e8f0;
        border-radius: 20px;
        padding: 32px;
        display: flex;
        flex-direction: column;
        gap: 24px;
    }

    .panel__title h2 {
        margin: 0 0 6px;
        font-size: 1.4rem;
        color: #0f172a;
    }

    .panel__title p {
        margin: 0;
        color: #475569;
    }

    .form-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
    }

    .form-field {
        display: flex;
        flex-direction: column;
        gap: 8px;
        font-size: 0.9rem;
        color: #0f172a;
    }

    .form-field input,
    .form-field select {
        border-radius: 12px;
        border: 1px solid #e2e8f0;
        padding: 12px 14px;
        font-size: 1rem;
        transition: border-color 0.2s, box-shadow 0.2s;
    }

    .form-field input:focus,
    .form-field select:focus {
        border-color: #6366f1;
        outline: none;
        box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    }

    .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
    }

    .btn {
        border: none;
        border-radius: 999px;
        padding: 12px 20px;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        color: #fff;
        transition: opacity 0.2s, transform 0.1s;
    }

    .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }

    .btn:not(:disabled):active {
        transform: translateY(1px);
    }

    .btn--ghost {
        background: rgba(99, 102, 241, 0.15);
        color: #312e81;
    }

    .status-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 16px;
    }

    .status-list li {
        padding: 16px;
        border-radius: 12px;
        background: #f8fafc;
        display: flex;
        flex-direction: column;
        gap: 4px;
        border: 1px solid #e2e8f0;
    }

    .status-list span {
        color: #64748b;
        font-size: 0.85rem;
    }

.status-list strong {
    color: #0f172a;
}

.accounts {
    border: 1px dashed #cbd5e1;
    border-radius: 12px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.accounts__header {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
    gap: 4px;
}

.accounts__title {
    margin: 0;
    font-weight: 700;
    color: #0f172a;
}

.accounts__subtitle {
    margin: 0;
    color: #475569;
    font-size: 0.9rem;
}

.accounts__list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.account-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    background: #f8fafc;
}

.account-row__main {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    cursor: pointer;
}

.account-row__email {
    margin: 0;
    font-weight: 600;
    color: #0f172a;
}

.account-row__status {
    margin: 2px 0 0;
    color: #475569;
    font-size: 0.85rem;
    display: flex;
    align-items: center;
    gap: 6px;
}

.account-row__actions {
    display: flex;
    gap: 8px;
}

.btn--tiny {
    padding: 8px 12px;
    font-size: 0.9rem;
}

.btn--danger {
    background: rgba(239, 68, 68, 0.12);
    color: #b91c1c;
}

.search {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

    .placeholder {
        padding: 16px;
        border-radius: 12px;
        background: #f8fafc;
        color: #475569;
    }

.results {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

    .cards {
        display: grid;
        gap: 14px;
        grid-template-columns: 1fr;
    }

    .email-card {
        border: 1px solid #e2e8f0;
        border-radius: 16px;
        padding: 16px;
        background: #fff;
        display: flex;
        flex-direction: column;
        gap: 12px;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
    }

    .email-card header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
    }

    .email-card__subject {
        margin: 0;
        font-weight: 700;
        color: #0f172a;
    }

    .email-card__from,
    .email-card__to {
        margin: 2px 0 0;
        color: #475569;
        font-size: 0.9rem;
    }

    .email-card__meta {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
    }

    .email-card__date {
        margin: 0;
        color: #475569;
        font-size: 0.85rem;
    }

    .email-card__body {
        margin: 0;
        color: #475569;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 0.95rem;
        line-height: 1.5;
    }

    .email-card__footer {
        display: flex;
        justify-content: flex-end;
    }

    .pill {
        display: inline-flex;
        align-items: center;
        padding: 4px 10px;
        border-radius: 999px;
        background: #eef2ff;
        color: #312e81;
        font-size: 0.85rem;
    }

    .pill--warn {
        background: #fef3c7;
        color: #92400e;
    }

    .modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.55);
        display: flex;
        justify-content: center;
        align-items: flex-start;
        padding: 32px 16px;
        overflow-y: auto;
        z-index: 10;
    }

    .modal {
        position: relative;
        background: #fff;
        border-radius: 16px;
        padding: 24px;
        width: min(820px, 100%);
        box-shadow: 0 30px 80px rgba(15, 23, 42, 0.35);
        color: #0f172a;
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .modal__close {
        position: absolute;
        top: 10px;
        right: 10px;
        border: none;
        background: transparent;
        font-size: 1.5rem;
        cursor: pointer;
        color: #475569;
        line-height: 1;
    }

    .modal__eyebrow {
        margin: 0;
        text-transform: uppercase;
        letter-spacing: 0.15em;
        color: #6366f1;
        font-weight: 700;
        font-size: 0.75rem;
    }

    .modal__subject {
        margin: 4px 0;
        font-size: 1.4rem;
        color: #0f172a;
    }

    .modal__meta {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 4px;
    }

    .modal__date {
        color: #475569;
        font-size: 0.9rem;
    }

    .modal__from,
    .modal__to {
        margin: 0;
        color: #475569;
        font-size: 0.95rem;
    }

    .modal__body {
        margin-top: 6px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 14px;
    }

    .modal__body p {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        color: #0f172a;
        line-height: 1.6;
    }

    .modal__body .modal__empty {
        color: #475569;
        font-size: 0.95rem;
        margin: 0;
    }

    @media (max-width: 720px) {
        .gmail-card {
            padding: 32px 24px;
        }

        .panel {
            padding: 24px;
        }
    }
</style>
