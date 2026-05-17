// DESIGN.md §16. i18next + react-i18next + browser-languagedetector + ICU.
// V1 ships zh-CN (default) + en-US. localStorage 'mailagent.language' overrides
// the detector; absent → falls back to navigator.language → zh-CN.

import i18n from 'i18next'
import ICU from 'i18next-icu'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

import zhCommon from './locales/zh-CN/common.json'
import enCommon from './locales/en-US/common.json'

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

void i18n
  .use(ICU)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { common: zhCommon },
      'en-US': { common: enCommon }
    },
    fallbackLng: 'zh-CN',
    supportedLngs: SUPPORTED_LOCALES as unknown as string[],
    defaultNS: 'common',
    ns: ['common'],
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'mailagent.language',
      caches: ['localStorage']
    },
    interpolation: {
      escapeValue: false
    }
  })

export default i18n
