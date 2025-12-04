import { computed, onMounted, ref, watch, useNuxtApp } from "#imports"

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

export interface AccountSession {
    email: string
    token?: string
    lastAuthorized?: string
    needsConsent?: boolean
}

export type StatusKind = "idle" | "info" | "success" | "error"

const discoveryDocs = ["https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest"]
const scopes = ["https://www.googleapis.com/auth/gmail.readonly"]

export const STORAGE_KEYS = {
    clientId: "gmail-actions/client-id",
    apiKey: "gmail-actions/api-key",
    searchQuery: "gmail-actions/search-query",
    searchScope: "gmail-actions/search-scope",
    accounts: "gmail-actions/accounts",
    selectedAccounts: "gmail-actions/selected-accounts",
} as const

type LogMeta = Record<string, unknown>
type LogLevel = "debug" | "info" | "warn" | "error"

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
            (message.toLowerCase().includes("key") && message.toLowerCase().includes("invalid")),
        hint:
            "API key appears invalid or restricted. Make sure the key is unrestricted or allows http://localhost:3000 as an HTTP referrer and that the Gmail API is enabled for the project. You can also leave the API key blank and rely on OAuth only.",
    },
]

export const useGmailAuth = () => {
    const clientId = ref("")
    const apiKey = ref("")
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
    const isClient = ref(false)
    const currentOrigin = ref("")
    const oauthRedirectUri = computed(() =>
        currentOrigin.value ? `${currentOrigin.value}/oauth2callback` : "Add custom redirect URI if needed"
    )
    const readyForSearch = computed(() => isSignedIn.value && gapiReady.value)

    const nuxtApp = useNuxtApp()
    const loggerTarget = (nuxtApp.$logger as Partial<Console> | undefined) ?? console

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

            logDebug("Restored stored auth values", {
                hasClientId: Boolean(clientId.value),
                hasApiKey: Boolean(apiKey.value),
                storedAccounts: accounts.value.length,
                selectedAccounts: selectedAccounts.value.length,
            })
        } catch (error) {
            logWarn("Unable to restore stored auth values", { error })
        }
    }

    const persistAccounts = () => {
        if (typeof window === "undefined") return
        localStorage.setItem(STORAGE_KEYS.accounts, JSON.stringify(accounts.value))
        localStorage.setItem(STORAGE_KEYS.selectedAccounts, JSON.stringify(selectedAccounts.value))
    }

    if (typeof window !== "undefined") {
        watch(clientId, (value) => {
            localStorage.setItem(STORAGE_KEYS.clientId, value.trim())
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

    const fetchUserProfile = async (): Promise<string> => {
        const gapi = window.gapi
        const response = await gapi.client.gmail.users.getProfile({ userId: "me" })
        const email = response.result.emailAddress || "unknown"
        logInfo("Fetched Gmail profile", { email })
        return email
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

    const authorizeGmail = async () => {
        loadingAuthorize.value = true
        try {
            setStatus("Preparing Google authorization flow…", "info")
            logInfo("Starting Gmail authorization flow")
            await initClient()
            const token = await requestAccessToken({
                promptMode: "consent",
                forcePrompt: true,
                forceSelectAccount: true,
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

    return {
        clientId,
        apiKey,
        googleScriptLoaded,
        gisScriptLoaded,
        gapiReady,
        accounts,
        selectedAccounts,
        isSignedIn,
        statusText,
        statusType,
        loadingAuthorize,
        oauthRedirectUri,
        readyForSearch,
        accessToken,
        authorizeAccount,
        authorizeGmail,
        requestAccessToken,
        restoreAccountsSilently,
        addOrUpdateAccount,
        fetchUserProfile,
        signOut,
        removeAccount,
        setStatus,
        normalizeError,
        logDebug,
        logInfo,
        logWarn,
        logError,
    }
}
