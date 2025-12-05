import { computed, onMounted, ref, useNuxtApp, watch } from "#imports"
import { useLocalStorage, useScriptTag } from "@vueuse/core"

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

export const useGmailAuth = () => {
    const clientId = useLocalStorage<string>(STORAGE_KEYS.clientId, "")
    const googleScriptLoaded = ref(false)
    const gisScriptLoaded = ref(false)
    const gapiReady = ref(false)
    const tokenClient = ref<any | null>(null)
    const accessToken = ref("")
    const accounts = useLocalStorage<AccountSession[]>(STORAGE_KEYS.accounts, [])
    const selectedAccounts = useLocalStorage<string[]>(STORAGE_KEYS.selectedAccounts, [])
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

    const normalizeError = (error: unknown, fallback = "Something went wrong.") => {
        if (typeof error === "string") return error
        const enriched = extractGoogleErrorMessage(error)
        if (enriched) return enriched
        if (error && typeof error === "object" && "message" in error) {
            return String((error as Error).message || fallback)
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
    }

    accounts.value = normalizeAccounts(accounts.value)
    selectedAccounts.value = Array.isArray(selectedAccounts.value)
        ? selectedAccounts.value.filter((email) => typeof email === "string")
        : []

    watch(
        accounts,
        (list) => {
            const validEmails = new Set(list.map((a) => a.email))
            selectedAccounts.value = selectedAccounts.value.filter((email) => validEmails.has(email))
            if (!selectedAccounts.value.length && list.length) {
                selectedAccounts.value = list.map((a) => a.email)
            }
            isSignedIn.value = list.length > 0
        },
        { deep: true, immediate: true }
    )

    const googleApiScript = useScriptTag(
        "https://apis.google.com/js/api.js",
        () => {
            googleScriptLoaded.value = true
            logInfo("Google API script loaded")
        },
        { manual: true }
    )

    const gisScript = useScriptTag(
        "https://accounts.google.com/gsi/client",
        () => {
            gisScriptLoaded.value = true
            logInfo("Google Identity Services script loaded")
        },
        { manual: true }
    )

    const loadGoogleScript = async () => {
        if (!isClient.value) {
            throw new Error("Google API script can only be loaded in the browser.")
        }
        if (googleScriptLoaded.value) return
        const el = await googleApiScript.load()
        if (!el) {
            throw new Error("Unable to load the Google APIs script.")
        }
    }

    const loadGisScript = async () => {
        if (!isClient.value) {
            throw new Error("Google Identity Services script can only be loaded in the browser.")
        }
        if (gisScriptLoaded.value) return
        const el = await gisScript.load()
        if (!el) {
            throw new Error("Unable to load the Google Identity Services script.")
        }
    }

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
        isSignedIn.value = accounts.value.length > 0
        logInfo("Removed account", { email })
    }

    onMounted(async () => {
        isClient.value = true
        currentOrigin.value = window.location.origin

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
