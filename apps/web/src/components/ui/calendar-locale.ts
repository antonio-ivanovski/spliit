import type { DayPickerLocale } from 'react-day-picker'
import {
  arSA,
  bn,
  ca,
  cs,
  de,
  enGB,
  enUS,
  es,
  eu,
  fi,
  fr,
  he,
  hi,
  id,
  it,
  ja,
  ko,
  mk,
  nl,
  pl,
  pt,
  ptBR,
  ro,
  ru,
  sv,
  tr,
  uk,
  vi,
  zhCN,
  zhTW,
} from 'react-day-picker/locale'

import type { Locale } from '@spliit/domain/i18n'

const urduDateFormatter = new Intl.DateTimeFormat('ur-PK', {
  calendar: 'gregory',
  dateStyle: 'full',
})

// date-fns does not currently ship an Urdu locale. Extending the DayPicker
// English fallback keeps its calendar math while providing Urdu labels and
// allowing DateInput's Intl formatters to localize all visible dates.
const urPK: DayPickerLocale = {
  ...enUS,
  code: 'ur-PK',
  options: {
    firstWeekContainsDate: 1,
    weekStartsOn: 1,
  },
  labels: {
    labelDayButton: (date, modifiers) => {
      let label = urduDateFormatter.format(date)
      if (modifiers.today) label = `آج، ${label}`
      if (modifiers.selected) label = `${label}، منتخب`
      return label
    },
    labelGrid: (date) => urduDateFormatter.format(date),
    labelGridcell: (date, modifiers) =>
      `${modifiers?.today ? 'آج، ' : ''}${urduDateFormatter.format(date)}`,
    labelMonthDropdown: 'مہینہ منتخب کریں',
    labelNav: 'کیلنڈر نیویگیشن',
    labelNext: 'اگلے مہینے پر جائیں',
    labelPrevious: 'پچھلے مہینے پر جائیں',
    labelWeekday: (date) =>
      new Intl.DateTimeFormat('ur-PK', {
        calendar: 'gregory',
        weekday: 'long',
      }).format(date),
    labelWeekNumber: (weekNumber) => `ہفتہ ${weekNumber}`,
    labelWeekNumberHeader: 'ہفتہ نمبر',
    labelYearDropdown: 'سال منتخب کریں',
  },
}

const calendarLocaleByAppLocale: Record<Locale, DayPickerLocale> = {
  'ar-SA': arSA,
  'bn-BD': bn,
  'en-GZ': enUS,
  'hi-IN': hi,
  id,
  ca,
  'cs-CZ': cs,
  'de-DE': de,
  'en-GB': enGB,
  'en-US': enUS,
  es,
  eu,
  'fr-FR': fr,
  'it-IT': it,
  'nl-NL': nl,
  'pl-PL': pl,
  pt,
  'pt-BR': ptBR,
  ro,
  fi,
  'sv-SE': sv,
  'tr-TR': tr,
  'ru-RU': ru,
  'uk-UA': uk,
  he,
  ko,
  'mk-MK': mk,
  'ja-JP': ja,
  'ur-PK': urPK,
  vi,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
}

export function getCalendarLocale(locale: string): DayPickerLocale {
  return calendarLocaleByAppLocale[locale as Locale] ?? enUS
}
