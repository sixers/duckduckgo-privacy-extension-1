/**
 * This exposes some modules we use for testing via the background page console.
 * NOTE this is not added to the release version of the extension
 */
import * as startup from './startup'
const settings = require('./settings.es6')
const tabManager = require('./tab-manager.es6')
const atb = require('./atb.es6')
const https = require('./https.es6')
const tds = require('./storage/tds.es6')
const browserWrapper = require('./wrapper.es6')
const utils = require('./utils.es6')
const Tab = require('./classes/tab.es6')
const { TabState } = require('./classes/tab-state')
const Wrapper = require('./wrapper.es6.js')
const { setListContents, getListContents } = require('./message-handlers')

// @ts-ignore - dbg is not a standard property of self.
self.dbg = {
    settings,
    startup,
    tabManager,
    Tab,
    TabState,
    Wrapper,
    atb,
    https,
    tds,
    browserWrapper,
    utils,
    setListContents,
    getListContents
}

// mark this as a dev build
// when we request certain resources, this flag will prevent any
// metrics from being thrown off
browserWrapper.setToSessionStorage('dev', true)
