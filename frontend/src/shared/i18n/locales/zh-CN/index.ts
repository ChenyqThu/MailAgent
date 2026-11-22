import agents from './agents.json'
import calendar from './calendar.json'
import chat from './chat.json'
import contacts from './contacts.json'
import core from './core.json'
import email from './email.json'
import library from './library.json'
import matters from './matters.json'
import settings from './settings.json'

const common: typeof core &
  typeof email &
  typeof settings &
  typeof matters &
  typeof chat &
  typeof agents &
  typeof contacts &
  typeof calendar &
  typeof library = {
  ...core,
  ...email,
  ...settings,
  ...matters,
  ...chat,
  ...agents,
  ...contacts,
  ...calendar,
  ...library
}

export default common
