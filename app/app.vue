<script setup lang="ts">
    import { computed, onMounted, ref, watch } from "vue"

    declare global {
        interface Window {
            gapi?: any
        }
    }

    interface GmailMessage {
        id: string
        threadId: string
        subject: string
        from: string
        date: string
        snippet: string
    }

    type StatusKind = "idle" | "info" | "success" | "error"

    const discoveryDocs = ["https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest"]
    const scopes = ["https://www.googleapis.com/auth/gmail.readonly"]
    const STORAGE_KEYS = {
        clientId: "gmail-actions/client-id",
        apiKey: "gmail-actions/api-key",
        searchQuery: "gmail-actions/search-query",
    } as const

    const clientId = ref("")
    const apiKey = ref("")
    const searchQuery = ref("label:inbox newer_than:7d")
    const googleScriptLoaded = ref(false)
    const gapiReady = ref(false)
    const authInstance = ref<any | null>(null)
    const isSignedIn = ref(false)
    const statusText = ref("Provide your Client ID and API key, then authorize access to Gmail.")
    const statusType = ref<StatusKind>("info")
    const loadingAuthorize = ref(false)
    const loadingSearch = ref(false)
    const messages = ref<GmailMessage[]>([])
    const isClient = ref(false)
    const currentOrigin = ref("")
    const oauthRedirectUri = computed(() =>
        currentOrigin.value ? `${currentOrigin.value}/oauth2callback` : "Add custom redirect URI if needed"
    )

    const restoreStoredValues = () => {
        if (typeof window === "undefined") {
            return
        }

        try {
            clientId.value = localStorage.getItem(STORAGE_KEYS.clientId) ?? ""
            apiKey.value = localStorage.getItem(STORAGE_KEYS.apiKey) ?? ""
            const storedQuery = localStorage.getItem(STORAGE_KEYS.searchQuery)
            if (storedQuery) {
                searchQuery.value = storedQuery
            }
        } catch (error) {
            console.warn("Unable to restore stored values", error)
        }
    }

    onMounted(() => {
        isClient.value = true
        currentOrigin.value = window.location.origin
        restoreStoredValues()
    })

    if (typeof window !== "undefined") {
        watch(clientId, (value) => {
            localStorage.setItem(STORAGE_KEYS.clientId, value.trim())
        })
        watch(apiKey, (value) => {
            localStorage.setItem(STORAGE_KEYS.apiKey, value.trim())
        })
        watch(searchQuery, (value) => {
            localStorage.setItem(STORAGE_KEYS.searchQuery, value)
        })
    }

    const readyForSearch = computed(() => isSignedIn.value && gapiReady.value)

    const KNOWN_ERROR_HINTS: Array<{ match: (message: string) => boolean; hint: string }> = [
        {
            match: (message) => message.includes("idpiframe_initialization_failed"),
            hint:
                "Google Sign-In cannot start. Add your development origin (e.g. http://localhost:3000) to the OAuth client's Authorized JavaScript origins, and allow third-party cookies/pop-ups for this site.",
        },
        {
            match: (message) => message.includes("popup_blocked_by_browser"),
            hint: "Your browser blocked Google's popup. Allow popups for this site and try again.",
        },
    ]

    const extractGoogleErrorMessage = (error: unknown) => {
        if (!error || typeof error !== "object") {
            return ""
        }

        const maybeError = error as Record<string, unknown>
        if (typeof maybeError.message === "string" && maybeError.message.trim()) {
            return maybeError.message.trim()
        }

        const gapiResult = maybeError.result as { error?: { message?: string; status?: string } } | undefined
        const gapiError = gapiResult?.error
        if (gapiError?.message) {
            return gapiError.status ? `${gapiError.status}: ${gapiError.message}` : gapiError.message
        }

        if (typeof maybeError.error === "string" && maybeError.error.trim()) {
            return maybeError.error.trim()
        }

        return ""
    }

    const attachFriendlyHint = (message: string) => {
        const match = KNOWN_ERROR_HINTS.find((entry) => entry.match(message))
        return match ? `${message} – ${match.hint}` : message
    }

    const normalizeError = (error: unknown, fallback = "Something went wrong.") => {
        if (typeof error === "string") {
            return attachFriendlyHint(error)
        }

        const enriched = extractGoogleErrorMessage(error)
        if (enriched) {
            return attachFriendlyHint(enriched)
        }

        if (error && typeof error === "object" && "message" in error) {
            return attachFriendlyHint(String((error as Error).message || fallback))
        }

        return fallback
    }

    const setStatus = (message: string, type: StatusKind = "info") => {
        statusText.value = message
        statusType.value = type
    }

    const ensureCredentials = () => {
        if (!clientId.value.trim() || !apiKey.value.trim()) {
            throw new Error("Client ID and API key are required.")
        }
    }

    const loadGoogleScript = () =>
        new Promise<void>((resolve, reject) => {
            if (!isClient.value) {
                reject(new Error("Google API script can only be loaded in the browser."))
                return
            }

            if (googleScriptLoaded.value) {
                resolve()
                return
            }

            if (document.querySelector("script[data-google-apis]")) {
                googleScriptLoaded.value = true
                resolve()
                return
            }

            const script = document.createElement("script")
            script.src = "https://apis.google.com/js/api.js"
            script.async = true
            script.defer = true
            script.dataset.googleApis = "true"
            script.onload = () => {
                googleScriptLoaded.value = true
                resolve()
            }
            script.onerror = () => reject(new Error("Unable to load the Google APIs script."))
            document.head.appendChild(script)
        })

    const initClient = async () => {
        ensureCredentials()
        await loadGoogleScript()

        const gapi = window.gapi
        if (!gapi) {
            throw new Error("Google APIs client not available.")
        }

        await new Promise<void>((resolve, reject) => {
            gapi.load("client:auth2", async () => {
                try {
                    await gapi.client.init({
                        apiKey: apiKey.value.trim(),
                        clientId: clientId.value.trim(),
                        discoveryDocs,
                        scope: scopes.join(" "),
                    })

                    authInstance.value = gapi.auth2.getAuthInstance()
                    if (!authInstance.value) {
                        throw new Error("Failed to create an auth instance.")
                    }

                    isSignedIn.value = authInstance.value.isSignedIn.get()
                    authInstance.value.isSignedIn.listen((signedIn: boolean) => {
                        isSignedIn.value = signedIn
                        if (!signedIn) {
                            messages.value = []
                        }
                    })

                    gapiReady.value = true
                    setStatus("Google API client is initialized.", "success")
                    resolve()
                } catch (err) {
                    reject(err)
                }
            })
        })
    }

    const authorizeGmail = async () => {
        loadingAuthorize.value = true
        try {
            setStatus("Preparing Google authorization flow…", "info")
            if (!gapiReady.value) {
                await initClient()
            }

            if (!authInstance.value) {
                throw new Error("Auth instance not ready.")
            }

            await authInstance.value.signIn()
            isSignedIn.value = true
            setStatus("Authorization successful. You can now search Gmail.", "success")
        } catch (error) {
            console.error("authorizeGmail failed", error)
            setStatus(normalizeError(error, "Authorization failed."), "error")
        } finally {
            loadingAuthorize.value = false
        }
    }

    const signOut = async () => {
        if (!authInstance.value) {
            return
        }

        await authInstance.value.signOut()
        isSignedIn.value = false
        messages.value = []
        setStatus("Disconnected from Gmail.", "info")
    }

    const parseHeader = (
        headers: Array<{ name: string; value: string }> | undefined,
        name: string
    ) => headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? ""

    const searchMailbox = async () => {
        if (!readyForSearch.value) {
            setStatus("Authorize Gmail before searching.", "error")
            return
        }

        if (!searchQuery.value.trim()) {
            setStatus("Enter a Gmail search query.", "error")
            return
        }

        loadingSearch.value = true
        setStatus("Contacting Gmail...", "info")

        try {
            const gapi = window.gapi
            const listResponse = await gapi.client.gmail.users.messages.list({
                userId: "me",
                q: searchQuery.value.trim(),
                maxResults: 10,
            })

            const candidateMessages = listResponse.result.messages ?? []
            if (!candidateMessages.length) {
                messages.value = []
                setStatus("No messages matched your query.", "info")
                return
            }

            const detailedMessages = await Promise.all(
                candidateMessages.map(async (message: { id: string; threadId: string }) => {
                    const detail = await gapi.client.gmail.users.messages.get({
                        userId: "me",
                        id: message.id,
                        format: "metadata",
                        metadataHeaders: ["Subject", "From", "Date"],
                    })

                    const headers = detail.result.payload?.headers ?? []
                    const result: GmailMessage = {
                        id: message.id,
                        threadId: message.threadId,
                        subject: parseHeader(headers, "Subject") || "(No subject)",
                        from: parseHeader(headers, "From") || "Unknown sender",
                        date: parseHeader(headers, "Date") || "Unknown date",
                        snippet: detail.result.snippet ?? "",
                    }
                    return result
                })
            )

            messages.value = detailedMessages
            setStatus(
                `Fetched ${detailedMessages.length} message${
                    detailedMessages.length === 1 ? "" : "s"
                }.`,
                "success"
            )
        } catch (error) {
            console.error("searchMailbox failed", error)
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
                <h1>Authorize Gmail &amp; search email contents</h1>
                <p class="lede">
                    Connect your Google account with OAuth 2.0, then run advanced Gmail search
                    queries directly from this workspace. Nothing is stored on our servers.
                </p>
            </header>

            <div
                class="status-bar"
                :class="`status-bar--${statusType}`"
            >
                <span>{{ statusText }}</span>
            </div>

            <section class="panel">
                <div class="panel__title">
                    <h2>1. Configure Google Cloud credentials</h2>
                    <p>
                        Use a Web OAuth Client ID with the Gmail API enabled inside Google Cloud
                        Console.
                    </p>
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

                    <label class="form-field">
                        <span>API key</span>
                        <input
                            v-model="apiKey"
                            type="text"
                            name="api-key"
                            autocomplete="off"
                            placeholder="AIzaSy..."
                        />
                    </label>
                </div>

                <div class="scopes">
                    <p>Requested scopes</p>
                    <div class="scope-tags">
                        <span
                            v-for="scope in scopes"
                            :key="scope"
                            class="tag"
                            >{{ scope }}</span
                        >
                    </div>
                </div>

                <div class="callout">
                    <p class="callout__title">Google Cloud setup checklist</p>
                    <ul>
                        <li>
                            <span>Authorized JavaScript origin</span>
                            <code>
                                {{ currentOrigin || "Open this page in a browser to copy the origin." }}
                            </code>
                        </li>
                        <li>
                            <span>Authorized redirect URI</span>
                            <code>{{ oauthRedirectUri }}</code>
                        </li>
                        <li>
                            <span>Browser</span>
                            <em>Allow third-party cookies and pop-ups for Google Sign-In.</em>
                        </li>
                    </ul>
                </div>

                <div class="actions">
                    <button
                        class="btn"
                        type="button"
                        :disabled="loadingAuthorize"
                        @click="authorizeGmail"
                    >
                        {{ loadingAuthorize ? "Authorizing…" : "Authorize Gmail" }}
                    </button>
                    <button
                        class="btn btn--ghost"
                        type="button"
                        :disabled="!isSignedIn"
                        @click="signOut"
                    >
                        Disconnect
                    </button>
                </div>

                <ul class="status-list">
                    <li>
                        <span>Google script</span>
                        <strong>{{ googleScriptLoaded ? "Loaded" : "Not loaded" }}</strong>
                    </li>
                    <li>
                        <span>API client</span>
                        <strong>{{ gapiReady ? "Initialized" : "Not initialized" }}</strong>
                    </li>
                    <li>
                        <span>Authorization</span>
                        <strong>{{ isSignedIn ? "Connected" : "Not connected" }}</strong>
                    </li>
                </ul>
            </section>

            <section class="panel">
                <div class="panel__title">
                    <h2>2. Search Gmail</h2>
                    <p>
                        Use Gmail search syntax (e.g. <code>from:customer has:attachment</code>) to
                        narrow down the results.
                    </p>
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
                    <div class="actions">
                        <button
                            class="btn"
                            type="submit"
                            :disabled="!readyForSearch || loadingSearch"
                        >
                            {{ loadingSearch ? "Searching…" : "Search mailbox" }}
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
                    <div v-else>
                        <article
                            v-for="message in messages"
                            :key="message.id"
                            class="message"
                        >
                            <header>
                                <div>
                                    <p class="message__from">{{ message.from }}</p>
                                    <p class="message__subject">{{ message.subject }}</p>
                                </div>
                                <p class="message__date">{{ message.date }}</p>
                            </header>
                            <p class="message__snippet">{{ message.snippet }}</p>
                            <footer>
                                <code>Message ID: {{ message.id }}</code>
                            </footer>
                        </article>
                    </div>
                </div>
            </section>
        </main>
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

    .form-field input {
        border-radius: 12px;
        border: 1px solid #e2e8f0;
        padding: 12px 14px;
        font-size: 1rem;
        transition: border-color 0.2s, box-shadow 0.2s;
    }

    .form-field input:focus {
        border-color: #6366f1;
        outline: none;
        box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    }

.scopes {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.scope-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.tag {
    background: #e0e7ff;
    color: #312e81;
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 0.85rem;
}

.callout {
    border-radius: 16px;
    border: 1px solid #c7d2fe;
    background: #eef2ff;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    color: #312e81;
}

.callout__title {
    margin: 0;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    font-size: 0.85rem;
}

.callout ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.callout li {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.callout code {
    background: rgba(49, 46, 129, 0.1);
    border-radius: 8px;
    padding: 4px 8px;
    font-size: 0.9rem;
    word-break: break-all;
}

.callout em {
    font-style: normal;
    font-size: 0.9rem;
    color: #4338ca;
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

    .message {
        border: 1px solid #e2e8f0;
        border-radius: 18px;
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        background: #fff;
    }

    .message header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
    }

    .message__from {
        font-weight: 600;
        color: #0f172a;
        margin: 0;
    }

    .message__subject {
        margin: 4px 0 0;
        color: #4338ca;
    }

    .message__date {
        margin: 0;
        color: #475569;
        font-size: 0.9rem;
    }

    .message__snippet {
        margin: 0;
        color: #475569;
    }

    .message footer {
        font-size: 0.75rem;
        color: #94a3b8;
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
