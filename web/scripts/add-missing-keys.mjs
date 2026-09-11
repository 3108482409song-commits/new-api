import fs from 'node:fs/promises'
import path from 'node:path'

const LOCALES_DIR = path.resolve('src/i18n/locales')

function stableStringify(obj) {
  return JSON.stringify(obj, null, 2) + '\n'
}

const newKeys = {
  en: {
    'Open task details': 'Open task details',
    'Video pricing will be added when video models are available':
      'Video pricing will be added when video models are available',
  },
  zh: {
    'Open task details': '打开任务详情',
    'Video pricing will be added when video models are available': '视频模型上线后将提供视频价格',
  },
  'zh-TW': {
    'Open task details': '開啟任務詳情',
    'Video pricing will be added when video models are available': '影片模型上線後將提供影片價格',
  },
  fr: {
    'Open task details': 'Ouvrir les détails de la tâche',
    'Video pricing will be added when video models are available':
      'Le prix des vidéos sera ajouté lorsque les modèles vidéo seront disponibles',
  },
  ja: {
    'Open task details': 'タスクの詳細を開く',
    'Video pricing will be added when video models are available':
      '動画モデルの提供開始後に動画料金を追加します',
  },
  ru: {
    'Open task details': 'Открыть сведения о задаче',
    'Video pricing will be added when video models are available':
      'Цена видео появится после запуска видеомоделей',
  },
  vi: {
    'Open task details': 'Mở chi tiết tác vụ',
    'Video pricing will be added when video models are available':
      'Giá video sẽ được bổ sung khi các mô hình video khả dụng',
  },
}

async function main() {
  let totalAdded = 0

  for (const [locale, translations] of Object.entries(newKeys)) {
    const filePath = path.join(LOCALES_DIR, `${locale}.json`)
    const json = JSON.parse(await fs.readFile(filePath, 'utf8'))
    let count = 0

    for (const [key, value] of Object.entries(translations)) {
      if (json.translation[key] !== value) {
        json.translation[key] = value
        count++
      }
    }

    if (count > 0) {
      json.translation = Object.fromEntries(
        Object.entries(json.translation).sort(([a], [b]) => a.localeCompare(b)),
      )
      await fs.writeFile(filePath, stableStringify(json), 'utf8')
    }

    console.log(`${locale}: ${count} translations applied`)
    totalAdded += count
  }

  console.log(`\nTotal: ${totalAdded} translations applied`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
