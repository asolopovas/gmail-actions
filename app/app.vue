<script setup lang="ts">
    import { computed, onMounted, ref, watch } from "vue"

    declare global {
        interface Window {
            gapi?: any
            google?: {
                accounts?: {
                    oauth2?: {
                        initTokenClient: (config: Record<string, unknown>) => any
                        revoke: (token: string, done: () => void) => void
                    }
                }
            }
        }
    }

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

    interface AccountSession {
        email: string
        token?: string
        lastAuthorized?: string
        needsConsent?: boolean
    }

    type StatusKind = "idle" | "info" | "success" | "error"

    const discoveryDocs = ["https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest"]
    const scopes = ["https://www.googleapis.com/auth/gmail.readonly"]
    const STORAGE_KEYS = {
        clientId: "gmail-actions/client-id",
        apiKey: "gmail-actions/api-key",
        searchQuery: "gmail-actions/search-query",
        searchScope: "gmail-actions/search-scope",
        accounts: "gmail-actions/accounts",
        selectedAccounts: "gmail-actions/selected-accounts",
    } as const

    const clientId = ref("")
    const apiKey = ref("")
    const searchQuery = ref("label:inbox newer_than:7d")
    const searchScope = ref("anywhere")
    const googleScriptLoaded = ref(false)
    const gisScriptLoaded = ref(false)
    const gapiReady = ref(false)
    const tokenClient = ref<any | null>(null)
    const accessToken = ref("")
    const accounts = ref<AccountSession[]>([])
    const selectedAccounts = ref<string[]>([])
    const isSignedIn = ref(false)
    const statusText = ref("Provide your Client ID and API key, then authorize access to Gmail.")
    const statusType = ref<StatusKind>("info")
    const loadingAuthorize = ref(false)
    const loadingSearch = ref(false)
    const messages = ref<GmailMessage[]>([])
    const selectedMessage = ref<GmailMessage | null>(null)
    const isClient = ref(false)
    const currentOrigin = ref("")
    const oauthRedirectUri = computed(() =>
        currentOrigin.value ? `${currentOrigin.value}/oauth2callback` : "Add custom redirect URI if needed"
    )
    const nuxtApp = useNuxtApp()
    const loggerTarget = (nuxtApp.$logger as Partial<Console> | undefined) ?? console

    type LogMeta = Record<string, unknown>
    type LogLevel = "debug" | "info" | "warn" | "error"

    const logMessage = (level: LogLevel, message: string, meta?: LogMeta) => {
        const fn =
            (loggerTarget as Record<string, (...args: any[]) => void>)[level] ??
            console[level] ??
            console.log
        if (meta) {
            fn.call(loggerTarget, message, meta)
        } else {
            fn.call(loggerTarget, message)
        }
    }

    const logDebug = (message: string, meta?: LogMeta) => logMessage("debug", message, meta)
    const logInfo = (message: string, meta?: LogMeta) => logMessage("info", message, meta)
    const logWarn = (message: string, meta?: LogMeta) => logMessage("warn", message, meta)
    const logError = (message: string, meta?: LogMeta) => logMessage("error", message, meta)

    const normalizeAccounts = (input: unknown): AccountSession[] => {
        if (!Array.isArray(input)) return []
        const normalized: AccountSession[] = []
        for (const item of input) {
            if (typeof item === "string") {
                normalized.push({ email: item })
                continue
            }
            if (item && typeof item === "object" && "email" in item && typeof (item as any).email === "string") {
                const candidate = item as Record<string, unknown>
                normalized.push({
                    email: candidate.email as string,
                    token: typeof candidate.token === "string" ? (candidate.token as string) : undefined,
                    lastAuthorized:
                        typeof candidate.lastAuthorized === "string" ? (candidate.lastAuthorized as string) : undefined,
                    needsConsent: Boolean(candidate.needsConsent),
                })
            }
        }
        return normalized
    }

    const restoreStoredValues = () => {
        if (typeof window === "undefined") {
            return
        }

        try {
            clientId.value = localStorage.getItem(STORAGE_KEYS.clientId) ?? ""
            apiKey.value = localStorage.getItem(STORAGE_KEYS.apiKey) ?? ""
            searchScope.value = localStorage.getItem(STORAGE_KEYS.searchScope) ?? "anywhere"

            const storedQuery = localStorage.getItem(STORAGE_KEYS.searchQuery)
            if (storedQuery) {
                searchQuery.value = storedQuery
            }

            const storedAccounts = localStorage.getItem(STORAGE_KEYS.accounts)
            if (storedAccounts) {
                accounts.value = normalizeAccounts(JSON.parse(storedAccounts))
            }

            const storedSelected = localStorage.getItem(STORAGE_KEYS.selectedAccounts)
            if (storedSelected) {
                const parsed = JSON.parse(storedSelected)
                selectedAccounts.value = Array.isArray(parsed)
                    ? parsed.filter((item: unknown) => typeof item === "string")
                    : []
            }

            const validEmails = new Set(accounts.value.map((a) => a.email))
            selectedAccounts.value = selectedAccounts.value.filter((email) => validEmails.has(email))

            if (!selectedAccounts.value.length && accounts.value.length) {
                selectedAccounts.value = accounts.value.map((a) => a.email)
            }

            logDebug("Restored stored values", {
                hasClientId: Boolean(clientId.value),
                hasApiKey: Boolean(apiKey.value),
                hasQuery: Boolean(searchQuery.value),
                storedAccounts: accounts.value.length,
                selectedAccounts: selectedAccounts.value.length,
                scope: searchScope.value,
            })
        } catch (error) {
            logWarn("Unable to restore stored values", { error })
        }
    }

    const persistAccounts = () => {
        if (typeof window === "undefined") return
        localStorage.setItem(STORAGE_KEYS.accounts, JSON.stringify(accounts.value))
        localStorage.setItem(STORAGE_KEYS.selectedAccounts, JSON.stringify(selectedAccounts.value))
    }

    onMounted(async () => {
        isClient.value = true
        currentOrigin.value = window.location.origin
        restoreStoredValues()

        if (accounts.value.length) {
            isSignedIn.value = true
        }

        if (clientId.value.trim()) {
            try {
                await initClient()
            } catch (error) {
                logWarn("Auto-initialization failed", { error })
            }
        }
    })

    if (typeof window !== "undefined") {
        watch(clientId, (value) => {
            localStorage.setItem(STORAGE_KEYS.clientId, value.trim())
        })
        watch(searchQuery, (value) => {
            localStorage.setItem(STORAGE_KEYS.searchQuery, value)
        })
        watch(searchScope, (value) => {
            localStorage.setItem(STORAGE_KEYS.searchScope, value)
        })
        watch(
            accounts,
            () => {
                persistAccounts()
            },
            { deep: true }
        )
        watch(selectedAccounts, (value) => {
            localStorage.setItem(STORAGE_KEYS.selectedAccounts, JSON.stringify(value))
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
        {
            match: (message) =>
                message.toLowerCase().includes("api key not valid") ||
                message.toLowerCase().includes("api key") ||
                message.toLowerCase().includes("key") && message.toLowerCase().includes("invalid"),
            hint:
                "API key appears invalid or restricted. Make sure the key is unrestricted or allows http://localhost:3000 as an HTTP referrer and that the Gmail API is enabled for the project. You can also leave the API key blank and rely on OAuth only.",
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

        if (typeof maybeError.error_description === "string" && maybeError.error_description.trim()) {
            return maybeError.error_description.trim()
        }

        if (
            maybeError.error &&
            typeof maybeError.error === "object" &&
            "message" in maybeError.error &&
            typeof (maybeError.error as Record<string, unknown>).message === "string"
        ) {
            const structured = maybeError.error as { message: string; status?: string }
            return structured.status ? `${structured.status}: ${structured.message}` : structured.message
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
        logDebug("Status updated", { message, type })
    }

    const ensureCredentials = () => {
        if (!clientId.value.trim()) {
            logWarn("Missing client ID")
            throw new Error("Client ID is required.")
        }
        if (!apiKey.value.trim()) {
            logWarn("API key not provided; continuing without a key")
        }
    }

    const loadGoogleScript = () =>
        new Promise<void>((resolve, reject) => {
            if (!isClient.value) {
                reject(new Error("Google API script can only be loaded in the browser."))
                return
            }

            if (googleScriptLoaded.value) {
                logDebug("Google API script already loaded")
                resolve()
                return
            }

            if (document.querySelector("script[data-google-apis]")) {
                googleScriptLoaded.value = true
                logDebug("Google API script detected in DOM")
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
                logInfo("Google API script loaded")
                resolve()
            }
            script.onerror = (event) => {
                logError("Unable to load the Google APIs script.", { event })
                reject(new Error("Unable to load the Google APIs script."))
            }
            document.head.appendChild(script)
        })

    const loadGisScript = () =>
        new Promise<void>((resolve, reject) => {
            if (!isClient.value) {
                reject(new Error("Google Identity Services script can only be loaded in the browser."))
                return
            }

            if (gisScriptLoaded.value) {
                logDebug("Google Identity Services script already loaded")
                resolve()
                return
            }

            if (document.querySelector("script[data-google-gis]")) {
                gisScriptLoaded.value = true
                logDebug("Google Identity Services script detected in DOM")
                resolve()
                return
            }

            const script = document.createElement("script")
            script.src = "https://accounts.google.com/gsi/client"
            script.async = true
            script.defer = true
            script.dataset.googleGis = "true"
            script.onload = () => {
                gisScriptLoaded.value = true
                logInfo("Google Identity Services script loaded")
                resolve()
            }
            script.onerror = (event) => {
                logError("Unable to load the Google Identity Services script.", { event })
                reject(new Error("Unable to load the Google Identity Services script."))
            }
            document.head.appendChild(script)
        })

    const setupTokenClient = (force = false) => {
        if (tokenClient.value && !force) {
            return
        }
        const googleAccounts = window.google?.accounts?.oauth2
        if (!googleAccounts) {
            throw new Error("Google Identity Services client not available.")
        }

        tokenClient.value = googleAccounts.initTokenClient({
            client_id: clientId.value.trim(),
            scope: scopes.join(" "),
            prompt: "",
            callback: () => {
                /* The callback is overridden before requesting a token. */
            },
        })
        logInfo("Token client initialized", { scopes: scopes.join(" ") })
    }

    const initClient = async () => {
        ensureCredentials()
        logInfo("Initializing Gmail API client")
        const providedApiKey = apiKey.value.trim()
        if (providedApiKey) {
            logWarn("Ignoring provided API key; using OAuth-only flow", { keyLength: providedApiKey.length })
            apiKey.value = ""
            if (typeof window !== "undefined") {
                localStorage.removeItem(STORAGE_KEYS.apiKey)
            }
        }
        await Promise.all([loadGoogleScript(), loadGisScript()])

        const gapi = window.gapi
        if (!gapi) {
            throw new Error("Google APIs client not available.")
        }

        await new Promise<void>((resolve, reject) => {
            gapi.load("client", async () => {
                try {
                    logInfo("Initializing gapi client with config", {
                        hasApiKey: false,
                        discoveryDocs,
                    })

                    await gapi.client.init({ discoveryDocs })

                    setupTokenClient()

                    gapiReady.value = true
                    setStatus("Google API client is initialized.", "success")
                    logInfo("Google API client initialized")
                    await restoreAccountsSilently()
                    resolve()
                } catch (err) {
                    logError("Failed to initialize Google API client", { error: err })
                    reject(err)
                }
            })
        })
    }

    const requestAccessToken = (
        options?: {
            promptMode?: "none" | "consent"
            hint?: string
            forcePrompt?: boolean
            forceSelectAccount?: boolean
        }
    ) =>
        new Promise<string>((resolve, reject) => {
            if (!tokenClient.value || options?.forcePrompt || options?.forceSelectAccount) {
                setupTokenClient(true)
            }

            const promptMode = options?.forcePrompt
                ? "consent"
                : options?.promptMode ?? (accessToken.value ? "none" : "consent")
            logInfo("Requesting Gmail access token", { prompt: promptMode, hint: options?.hint })
            let settled = false
            const cleanup = () => {
                settled = true
            }

            const handleSuccess = (tokenResponse: any) => {
                if (settled) {
                    return
                }
                cleanup()

                if (!tokenResponse || tokenResponse.error) {
                    logError("Token request returned an error payload", { error: tokenResponse })
                    reject(tokenResponse)
                    return
                }

                if (!tokenResponse.access_token) {
                    reject(new Error("Access token missing from Google response."))
                    return
                }

                accessToken.value = tokenResponse.access_token
                window.gapi?.client?.setToken(tokenResponse)
                isSignedIn.value = true
                logInfo("Received Gmail access token")
                resolve(tokenResponse.access_token)
            }

            const handleError = (errorResponse: any) => {
                if (settled) {
                    return
                }
                cleanup()
                logError("Google token client reported an error", { error: errorResponse })
                reject(errorResponse)
            }

            try {
                tokenClient.value.callback = handleSuccess
                ;(tokenClient.value as Record<string, any>).error_callback = handleError
                const requestOptions: Record<string, string> = {}
                if (promptMode === "consent" || options?.forceSelectAccount) {
                    requestOptions.prompt = options?.forceSelectAccount ? "consent select_account" : "consent"
                }
                if (options?.hint) {
                    requestOptions.login_hint = options.hint
                }
                tokenClient.value.requestAccessToken(requestOptions)
            } catch (error) {
                logError("Token request threw an exception", { error })
                reject(error)
            }
        })

    const authorizeGmail = async () => {
        loadingAuthorize.value = true
        try {
            setStatus("Preparing Google authorization flow…", "info")
            logInfo("Starting Gmail authorization flow")
            await initClient()
            const token = await requestAccessToken({ promptMode: "consent", forcePrompt: true, forceSelectAccount: true })

            const profileEmail = await fetchUserProfile()
            addOrUpdateAccount(profileEmail, token)

            setStatus("Authorization successful. You can now search Gmail.", "success")
            logInfo("Gmail authorization completed", { profileEmail })
        } catch (error) {
            logError("Gmail authorization failed", { error })
            setStatus(normalizeError(error, "Authorization failed."), "error")
        } finally {
            loadingAuthorize.value = false
        }
    }

    const authorizeAccount = async (hint?: string, opts?: { forcePrompt?: boolean; forceSelectAccount?: boolean }) => {
        loadingAuthorize.value = true
        try {
            setStatus("Preparing Google authorization flow…", "info")
            await initClient()

            if (opts?.forceSelectAccount) {
                accessToken.value = ""
                window.gapi?.client?.setToken(null)
                const token = await requestAccessToken({
                    promptMode: "consent",
                    forcePrompt: true,
                    forceSelectAccount: true,
                })
                const profileEmail = await fetchUserProfile()
                addOrUpdateAccount(profileEmail, token)
                setStatus("Authorization successful. You can now search Gmail.", "success")
                logInfo("Gmail authorization completed", { profileEmail })
                return
            }

            try {
                if (opts?.forcePrompt) {
                    accessToken.value = ""
                    window.gapi?.client?.setToken(null)
                }
                const token = await requestAccessToken({
                    promptMode: hint ? "none" : "consent",
                    hint,
                    forcePrompt: opts?.forcePrompt,
                    forceSelectAccount: opts?.forceSelectAccount,
                })
                const profileEmail = await fetchUserProfile()
                addOrUpdateAccount(profileEmail, token)
                setStatus("Authorization successful. You can now search Gmail.", "success")
                logInfo("Gmail authorization completed", { profileEmail })
                return
            } catch (error) {
                if (hint) {
                    logWarn("Silent auth failed, requesting consent", { hint, error })
                } else {
                    throw error
                }
            }

            const token = await requestAccessToken({
                promptMode: "consent",
                hint,
                forcePrompt: true,
                forceSelectAccount: opts?.forceSelectAccount ?? true,
            })
            const profileEmail = await fetchUserProfile()
            addOrUpdateAccount(profileEmail, token)
            setStatus("Authorization successful. You can now search Gmail.", "success")
            logInfo("Gmail authorization completed", { profileEmail })
        } catch (error) {
            logError("Gmail authorization failed", { error })
            setStatus(normalizeError(error, "Authorization failed."), "error")
        } finally {
            loadingAuthorize.value = false
        }
    }

    const signOut = async () => {
        logInfo("Signing out from Gmail")
        const googleAccounts = window.google?.accounts?.oauth2
        const tokensToRevoke = accounts.value.map((account) => account.token).filter(Boolean)
        for (const token of tokensToRevoke) {
            await new Promise<void>((resolve) => {
                if (!googleAccounts) {
                    resolve()
                    return
                }
                googleAccounts.revoke(token, () => resolve())
            })
        }

        window.gapi?.client?.setToken(null)
        accessToken.value = ""
        accounts.value = []
        selectedAccounts.value = []
        persistAccounts()
        isSignedIn.value = false
        messages.value = []
        selectedMessage.value = null
        setStatus("Disconnected from Gmail.", "info")
        logInfo("Completed sign out")
    }

    const removeAccount = async (email: string) => {
        const account = accounts.value.find((a) => a.email === email)
        const googleAccounts = window.google?.accounts?.oauth2
        if (account?.token) {
            await new Promise<void>((resolve) => {
                if (!googleAccounts) {
                    resolve()
                    return
                }
                googleAccounts.revoke(account.token as string, () => resolve())
            })
        }

        accounts.value = accounts.value.filter((a) => a.email !== email)
        selectedAccounts.value = selectedAccounts.value.filter((e) => e !== email)
        persistAccounts()
        isSignedIn.value = accounts.value.length > 0
        logInfo("Removed account", { email })
    }

    const parseHeader = (
        headers: Array<{ name: string; value: string }> | undefined,
        name: string
    ) => headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? ""

    const fetchUserProfile = async (): Promise<string> => {
        const gapi = window.gapi
        const response = await gapi.client.gmail.users.getProfile({ userId: "me" })
        const email = response.result.emailAddress || "unknown"
        logInfo("Fetched Gmail profile", { email })
        return email
    }

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

    const restoreAccountsSilently = async () => {
        if (!accounts.value.length || !gapiReady.value) return

        for (const account of accounts.value) {
            if (!account.token) {
                try {
                    const token = await requestAccessToken({ promptMode: "none", hint: account.email })
                    const profileEmail = await fetchUserProfile()
                    addOrUpdateAccount(profileEmail, token)
                    logInfo("Restored account silently", { email: profileEmail })
                } catch (error) {
                    logWarn("Silent restore failed for account without token", { email: account.email, error })
                }
            }
        }
        persistAccounts()
    }

    const addOrUpdateAccount = (email: string, token: string) => {
        const existing = accounts.value.find((account) => account.email === email)
        if (existing) {
            existing.token = token
            existing.needsConsent = false
            existing.lastAuthorized = new Date().toISOString()
        } else {
            accounts.value.push({ email, token, lastAuthorized: new Date().toISOString() })
        }

        if (!selectedAccounts.value.includes(email)) {
            selectedAccounts.value.push(email)
        }

        isSignedIn.value = accounts.value.length > 0
        logInfo("Account stored", { email, total: accounts.value.length })
        persistAccounts()
    }

    const openMessage = (message: GmailMessage) => {
        selectedMessage.value = message
    }

    const closeModal = () => {
        selectedMessage.value = null
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

    const scopeLookup: Record<string, string> = {
        anywhere: "",
        inbox: "in:inbox",
        sent: "in:sent",
        draft: "in:drafts",
        spam: "in:spam",
        trash: "in:trash",
        starred: "is:starred",
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
