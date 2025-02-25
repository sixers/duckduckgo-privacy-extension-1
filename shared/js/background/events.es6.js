/**
 * NOTE: this needs to be the first listener that's added
 *
 * on FF, we might actually miss the onInstalled event
 * if we do too much before adding it
 */
import browser from 'webextension-polyfill'
import * as messageHandlers from './message-handlers'
import { removeInverseRules } from './classes/custom-rules-manager'
import { flushSessionRules } from './declarative-net-request'
const ATB = require('./atb.es6')
const utils = require('./utils.es6')
const experiment = require('./experiments.es6')
const settings = require('./settings.es6')
const constants = require('../../data/constants')
const onboarding = require('./onboarding.es6')
const cspProtection = require('./csp-blocking.es6')
const browserName = utils.getBrowserName()
const devtools = require('./devtools.es6')
const tdsStorage = require('./storage/tds.es6')
const browserWrapper = require('./wrapper.es6')
const limitReferrerData = require('./events/referrer-trimming')
const { dropTracking3pCookiesFromResponse, dropTracking3pCookiesFromRequest, validateSetCookieBlock } = require('./events/3p-tracking-cookie-blocking')

const manifestVersion = browserWrapper.getManifestVersion()

async function onInstalled (details) {
    tdsStorage.initOnInstall()

    if (details.reason.match(/install/)) {
        await settings.ready()
        settings.updateSetting('showWelcomeBanner', true)
        if (browserName === 'chrome') {
            settings.updateSetting('showCounterMessaging', true)
        }
        await ATB.updateATBValues()
        await ATB.openPostInstallPage()

        if (browserName === 'chrome') {
            experiment.setActiveExperiment()
        }
    } else if (details.reason.match(/update/) && browserName === 'chrome') {
        if (manifestVersion === 3) {
            ATB.setOrUpdateATBdnrRule(settings.getSetting('atb'))
        }
        experiment.setActiveExperiment()
    }

    // remove any orphaned session rules (can happen on extension update/restart)
    if (manifestVersion === 3) {
        await settings.ready()

        await flushSessionRules()
    }

    // Inject the email content script on all tabs upon installation (not needed on Firefox)
    // FIXME the below code throws an unhandled exception in MV3
    try {
        if (browserName !== 'moz') {
            const tabs = await browser.tabs.query({})
            for (const tab of tabs) {
                // Ignore URLs that we aren't permitted to access
                if (tab.url.startsWith('chrome://')) {
                    continue
                }
                await browserWrapper.executeScript({
                    target: { tabId: tab.id },
                    files: ['public/js/content-scripts/autofill.js']
                })
            }
        }
    } catch (e) {
        console.warn('Failed to inject email content script at startup:', e)
    }
}

browser.runtime.onInstalled.addListener(onInstalled)

/**
 * ONBOARDING
 * Logic to allow the SERP to display onboarding UI
 */
async function onboardingMessaging ({ transitionQualifiers, tabId }) {
    await settings.ready()
    const showWelcomeBanner = settings.getSetting('showWelcomeBanner')
    const showCounterMessaging = settings.getSetting('showCounterMessaging')

    // If the onboarding messaging has already been displayed, there's no need
    // to trigger this event listener any longer.
    if (!showWelcomeBanner && !showCounterMessaging) {
        browser.webNavigation.onCommitted.removeListener(onboardingMessaging)
        return
    }

    // The counter messaging should only be active for the very first search
    // navigation observed.
    const isAddressBarQuery = transitionQualifiers.includes('from_address_bar')
    if (isAddressBarQuery && showCounterMessaging) {
        settings.removeSetting('showCounterMessaging')
    }

    // Clear the showWelcomeBanner setting to ensure that the welcome banner
    // isn't shown again in the future.
    if (showWelcomeBanner) {
        settings.removeSetting('showWelcomeBanner')
    }

    // Display the onboarding messaging.

    if (browserName === 'chrome') {
        browserWrapper.executeScript({
            target: { tabId },
            func: onboarding.onDocumentStart,
            args: [{
                duckDuckGoSerpHostname: constants.duckDuckGoSerpHostname
            }],
            injectImmediately: true
        })
    }

    browserWrapper.executeScript({
        target: { tabId },
        func: onboarding.onDocumentEnd,
        args: [{
            isAddressBarQuery,
            showWelcomeBanner,
            showCounterMessaging,
            browserName,
            duckDuckGoSerpHostname: constants.duckDuckGoSerpHostname,
            extensionId: browserWrapper.getExtensionId()
        }],
        injectImmediately: false
    })
}

browser.webNavigation.onCommitted.addListener(
    onboardingMessaging, {
        // We only target the search results page (SERP), which has a 'q' query
        // parameter. Two filters are required since the parameter is not
        // necessarily first.
        url: [
            {
                schemes: ['https'],
                hostEquals: constants.duckDuckGoSerpHostname,
                pathEquals: '/',
                queryContains: '?q='
            },
            {
                schemes: ['https'],
                hostEquals: constants.duckDuckGoSerpHostname,
                pathEquals: '/',
                queryContains: '&q='
            }
        ]
    }
)

/**
 * Health checks + `showCounterMessaging` mutation
 * (Chrome only)
 */
if (browserName === 'chrome') {
    chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
        if (request === 'healthCheckRequest') {
            sendResponse(true)
        } else if (request === 'rescheduleCounterMessagingRequest') {
            await settings.ready()
            settings.updateSetting('rescheduleCounterMessagingOnStart', true)
            sendResponse(true)
        }
    })

    browser.runtime.onStartup.addListener(async () => {
        await settings.ready()

        if (settings.getSetting('rescheduleCounterMessagingOnStart')) {
            settings.removeSetting('rescheduleCounterMessagingOnStart')
            settings.updateSetting('showCounterMessaging', true)
        }
    })
}

/**
 * REQUESTS
 */

const beforeRequest = require('./before-request.es6')
const tabManager = require('./tab-manager.es6')
const https = require('./https.es6')

let additionalOptions = []
if (manifestVersion === 2) {
    additionalOptions = ['blocking']
}
browser.webRequest.onBeforeRequest.addListener(
    beforeRequest.handleRequest,
    {
        urls: ['<all_urls>']
    },
    additionalOptions
)

// MV2 needs blocking for webRequest
// MV3 still needs some info from response headers
const extraInfoSpec = ['responseHeaders']
if (manifestVersion === 2) {
    extraInfoSpec.push('blocking')
}

if (browser.webRequest.OnHeadersReceivedOptions.EXTRA_HEADERS) {
    extraInfoSpec.push(browser.webRequest.OnHeadersReceivedOptions.EXTRA_HEADERS)
}

// We determine if browsingTopics is enabled by testing for availability of its
// JS API.
// Note: This approach will not work with MV3 since the background
//       ServiceWorker does not have access to a `document` Object.
const isTopicsEnabled = manifestVersion === 2 && 'browsingTopics' in document && utils.isFeatureEnabled('googleRejected')

browser.webRequest.onHeadersReceived.addListener(
    request => {
        if (request.type === 'main_frame') {
            tabManager.updateTabUrl(request)

            const tab = tabManager.get({ tabId: request.tabId })
            // SERP ad click detection
            if (
                utils.isRedirect(request.statusCode)
            ) {
                tab.setAdClickIfValidRedirect(request.url)
            } else if (tab && tab.adClick && tab.adClick.adClickRedirect && !utils.isRedirect(request.statusCode)) {
                tab.adClick.setAdBaseDomain(tab.site.baseDomain)
            }
        }

        if (ATB.shouldUpdateSetAtb(request)) {
            // returns a promise
            return ATB.updateSetAtb()
        }

        const responseHeaders = request.responseHeaders

        if (isTopicsEnabled && responseHeaders && (request.type === 'main_frame' || request.type === 'sub_frame')) {
            // there can be multiple permissions-policy headers, so we are good always appending one
            // According to Google's docs a site can opt out of browsing topics the same way as opting out of FLoC
            // https://privacysandbox.com/proposals/topics (See FAQ)
            responseHeaders.push({ name: 'permissions-policy', value: 'interest-cohort=()' })
        }

        return { responseHeaders }
    },
    { urls: ['<all_urls>'] },
    extraInfoSpec
)

// Store the created tab id for when onBeforeNavigate is called so data can be copied across from the source tab
const createdTargets = new Map()
browser.webNavigation.onCreatedNavigationTarget.addListener(details => {
    createdTargets.set(details.tabId, details.sourceTabId)
})

/**
 * Web Navigation
 */
// keep track of URLs that the browser navigates to.
//
// this is supplemented by tabManager.updateTabUrl() on headersReceived:
// tabManager.updateTabUrl only fires when a tab has finished loading with a 200,
// which misses a couple of edge cases like browser special pages
// and Gmail's weird redirect which returns a 200 via a service worker
browser.webNavigation.onBeforeNavigate.addListener(details => {
    // ignore navigation on iframes
    if (details.frameId !== 0) return

    const currentTab = tabManager.get({ tabId: details.tabId })

    if (manifestVersion === 3) {
        // Upon navigation, remove any custom action session rules that may have been applied to this tab
        // for example, by click-to-load to temporarily allow FB content to be displayed
        // Should we instead rely on chrome.webNavigation.onCommitted events, since a main_frame req may not result
        // in a navigation?O . TOH that may result in a race condition if reules aren't removed quickly enough
        removeInverseRules(currentTab)
    }

    const newTab = tabManager.create({ tabId: details.tabId, url: details.url })
    // persist the last URL the tab was trying to upgrade to HTTPS
    if (currentTab && currentTab.httpsRedirects) {
        newTab.httpsRedirects.persistMainFrameRedirect(currentTab.httpsRedirects.getMainFrameRedirect())
    }
    if (createdTargets.has(details.tabId)) {
        const sourceTabId = createdTargets.get(details.tabId)
        createdTargets.delete(details.tabId)

        const sourceTab = tabManager.get({ tabId: sourceTabId })
        if (sourceTab && sourceTab.adClick) {
            createdTargets.set(details.tabId, sourceTabId)
            if (sourceTab.adClick.shouldPropagateAdClickForNewTab(newTab)) {
                newTab.adClick = sourceTab.adClick.propagate(newTab.id)
            }
        }
    }

    newTab.updateSite(details.url)
    devtools.postMessage(details.tabId, 'tabChange', devtools.serializeTab(newTab))
})

/**
 * TABS
 */

const Companies = require('./companies.es6')

browser.tabs.onCreated.addListener((info) => {
    if (info.id) {
        tabManager.createOrUpdateTab(info.id, info)
    }
})

browser.tabs.onUpdated.addListener((id, info) => {
    // sync company data to storage when a tab finishes loading
    if (info.status === 'complete') {
        Companies.syncToStorage()
    }

    tabManager.createOrUpdateTab(id, info)
})

browser.tabs.onRemoved.addListener((id, info) => {
    // remove the tab object
    tabManager.delete(id)
})

// message popup to close when the active tab changes.
browser.tabs.onActivated.addListener(() => {
    browserWrapper.notifyPopup({ closePopup: true })
})

// search via omnibox
browser.omnibox.onInputEntered.addListener(async function (text) {
    const tabs = await browser.tabs.query({
        currentWindow: true,
        active: true
    })
    browser.tabs.update(tabs[0].id, {
        url: 'https://duckduckgo.com/?q=' + encodeURIComponent(text) + '&bext=' + utils.getOsName() + 'cl'
    })
})

/**
 * MESSAGES
 */
const {
    REFETCH_ALIAS_ALARM,
    fetchAlias
} = require('./email-utils.es6')

// Handle any messages that come from content/UI scripts
browser.runtime.onMessage.addListener((req, sender) => {
    if (sender.id !== browserWrapper.getExtensionId()) return

    // TODO clean up message passing
    const legacyMessageTypes = [
        'addUserData',
        'getUserData',
        'removeUserData',
        'getEmailProtectionCapabilities',
        'getAddresses',
        'refreshAlias',
        'debuggerMessage'
    ]
    for (const legacyMessageType of legacyMessageTypes) {
        if (legacyMessageType in req) {
            req.messageType = legacyMessageType
            req.options = req[legacyMessageType]
        }
    }

    if (req.registeredTempAutofillContentScript) {
        req.messageType = 'registeredContentScript'
    }

    if (req.messageType && req.messageType in messageHandlers) {
        return Promise.resolve(messageHandlers[req.messageType](req.options, sender, req))
    }

    // TODO clean up legacy onboarding messaging
    if (browserName === 'chrome') {
        if (req === 'healthCheckRequest' || req === 'rescheduleCounterMessagingRequest') {
            return
        }
    }

    console.error('Unrecognized message to background:', req, sender)
    return false
})

/*
 * Referrer Trimming
 */
if (manifestVersion === 2) {
    const referrerListenerOptions = ['blocking', 'requestHeaders']
    if (browser.webRequest.OnBeforeSendHeadersOptions.EXTRA_HEADERS) {
        referrerListenerOptions.push(browser.webRequest.OnBeforeSendHeadersOptions.EXTRA_HEADERS)
    }

    browser.webRequest.onBeforeSendHeaders.addListener(
        limitReferrerData,
        { urls: ['<all_urls>'] },
        referrerListenerOptions
    )
}

/**
 * Global Privacy Control
 */
const GPC = require('./GPC.es6')
const extraInfoSpecSendHeaders = ['requestHeaders']
if (browser.webRequest.OnBeforeSendHeadersOptions.EXTRA_HEADERS) {
    extraInfoSpecSendHeaders.push(browser.webRequest.OnBeforeSendHeadersOptions.EXTRA_HEADERS)
}

if (manifestVersion === 2) {
    extraInfoSpecSendHeaders.push('blocking')
    // Attach GPC header to all requests if enabled.
    browser.webRequest.onBeforeSendHeaders.addListener(
        request => {
            const tab = tabManager.get({ tabId: request.tabId })
            const GPCHeader = GPC.getHeader()
            const GPCEnabled = tab && tab.site.isFeatureEnabled('gpc')

            const requestHeaders = request.requestHeaders
            if (GPCHeader && GPCEnabled) {
                requestHeaders.push(GPCHeader)
            }

            return { requestHeaders }
        },
        { urls: ['<all_urls>'] },
        extraInfoSpecSendHeaders
    )
}

browser.webRequest.onBeforeSendHeaders.addListener(
    dropTracking3pCookiesFromRequest,
    { urls: ['<all_urls>'] },
    extraInfoSpecSendHeaders
)

browser.webRequest.onHeadersReceived.addListener(
    dropTracking3pCookiesFromResponse,
    { urls: ['<all_urls>'] },
    extraInfoSpec
)

if (manifestVersion === 3) {
    browser.webRequest.onCompleted.addListener(
        validateSetCookieBlock,
        { urls: ['<all_urls>'] },
        extraInfoSpec
    )
}

// Inject the Click to Load content script to display placeholders.
browser.webNavigation.onCommitted.addListener(details => {
    const tab = tabManager.get({ tabId: details.tabId })

    if (!tab || tab.site.specialDomainName) {
        return
    }

    if (tab.site.isBroken) {
        console.log('temporarily skip embedded object replacements for site: ' + details.url +
          'more info: https://github.com/duckduckgo/privacy-configuration')
        // eslint-disable-next-line
        return
    }
})

/**
 * ALARMS
 */

const httpsStorage = require('./storage/https.es6')
const httpsService = require('./https-service.es6')
const trackers = require('./trackers.es6')

browserWrapper.createAlarm('updateHTTPSLists', {
    periodInMinutes: httpsStorage.updatePeriodInMinutes
})
browserWrapper.createAlarm('updateLists', {
    periodInMinutes: tdsStorage.updatePeriodInMinutes
})
// update uninstall URL every 10 minutes
browserWrapper.createAlarm('updateUninstallURL', { periodInMinutes: 10 })
// remove expired HTTPS service entries
browserWrapper.createAlarm('clearExpiredHTTPSServiceCache', { periodInMinutes: 60 })
// Rotate the user agent spoofed
browserWrapper.createAlarm('rotateUserAgent', { periodInMinutes: 24 * 60 })
// Rotate the sessionKey
browserWrapper.createAlarm('rotateSessionKey', { periodInMinutes: 24 * 60 })

browser.alarms.onAlarm.addListener(async alarmEvent => {
    // Warning: Awaiting in this function doesn't actually wait for the promise to resolve before unblocking the main thread.
    if (alarmEvent.name === 'updateHTTPSLists') {
        await settings.ready()
        try {
            const lists = await httpsStorage.getLists()
            https.setLists(lists)
        } catch (e) {
            console.log(e)
        }
    } else if (alarmEvent.name === 'updateUninstallURL') {
        browser.runtime.setUninstallURL(await ATB.getSurveyURL())
    } else if (alarmEvent.name === 'updateLists') {
        await settings.ready()

        try {
            const lists = await tdsStorage.getLists()
            trackers.setLists(lists)
        } catch (e) {
            console.log(e)
        }
    } else if (alarmEvent.name === 'clearExpiredHTTPSServiceCache') {
        httpsService.clearExpiredCache()
    } else if (alarmEvent.name === 'rotateSessionKey') {
        await utils.resetSessionKey()
    } else if (alarmEvent.name === REFETCH_ALIAS_ALARM) {
        fetchAlias()
    }
})

// Count https upgrade failures to allow bad data to be removed from lists
browser.webRequest.onErrorOccurred.addListener(e => {
    if (!(e.type === 'main_frame')) return

    const tab = tabManager.get({ tabId: e.tabId })

    // We're only looking at failed main_frame upgrades. A tab can send multiple
    // main_frame request errors so we will only look at the first one then set tab.hasHttpsError.
    if (!tab || !tab.mainFrameUpgraded || tab.hasHttpsError) {
        return
    }

    if (e.error && e.url.match(/^https/)) {
        const errCode = constants.httpsErrorCodes[e.error]
        tab.hasHttpsError = true

        if (errCode) {
            https.incrementUpgradeCount('failedUpgrades')
        }
    }
}, { urls: ['<all_urls>'] })

if (browserName === 'moz') {
    cspProtection.init()
}
devtools.init()
