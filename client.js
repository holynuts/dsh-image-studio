/**
 * Image Studio — browser half (Harness Web client plugin).
 *
 * Loaded by the Harness Web module loader as a module factory, not imported by
 * Node. Plain ES5-ish JS: no JSX, no TypeScript, no bundler, no imports other
 * than React from the loader. Every visible string goes through the locale
 * service; every colour comes from a --dsw-alias-* theme token.
 *
 * Seats:
 *   sidebar.panellist  -> StudioIcon  (16x16 glyph, shell owns the row)
 *   main               -> StudioPage  (the panel itself, key 'image-studio')
 *
 * The panel talks to its host half over /api/image-studio (SPEC.md section 3).
 * No polling: bootstrap once, then every mutation is an explicit user action.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-image-studio',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    //#region Constants and locale plumbing
    /** Locale namespace owned by this plugin. */
    const NS = 'imageStudio'
    /** Sidebar row id and keyed main-slot key. */
    const PANEL_ID = 'image-studio'
    /** localStorage key that remembers the last tab. */
    const TAB_KEY = 'dsh.imageStudio.tab'
    /** Host API root (SPEC.md section 3). */
    const API_BASE = '/api/image-studio'
    /** Tab order in the segmented control. */
    const TABS = ['create', 'library', 'compare', 'settings']
    /** Absolute UI cap for reference images (the largest provider allows 14). */
    const MAX_REFS = 14
    /** Compare tops out at four targets. */
    const MAX_COMPARE = 4
    /** Library page size (SPEC.md default). */
    const PAGE_SIZE = 40

    /**
     * Translate a key with optional {name} template params.
     *
     * The locale service is bound in apply(); until then (and when a host
     * without the locale service loads this module) the dictionary matching
     * document.documentElement.lang is used directly, which keeps the sidebar
     * label and any early copy working.
     */
    let runtimeTranslate = null
    function tt(key, values) {
      if (typeof runtimeTranslate === 'function') {
        try {
          return runtimeTranslate(key, values)
        } catch (reason) {
          /* fall through to the local dictionary */
        }
      }
      let text = (activeDictionary()[key] !== undefined ? activeDictionary()[key] : key)
      if (values) {
        for (const name of Object.keys(values)) {
          text = String(text).split('{' + name + '}').join(String(values[name]))
        }
      }
      return text
    }
    function activeDictionary() {
      let lang = 'en'
      try {
        lang = String(document.documentElement.lang || 'en').toLowerCase()
      } catch (reason) {
        /* no document (tests) */
      }
      return lang.indexOf('zh') === 0 ? zh : en
    }
    //#endregion

    //#region Locale dictionaries (complete zh + en)
    const zh = {
      'panel.title': '图像工坊',
      'shell.subtitle': '{items} 条 · {images} 张图片', 'shell.loadingSub': '正在打开图像工坊…',
      'shell.openFolder': '打开文件夹', 'shell.refresh': '刷新', 'shell.refreshed': '图库已刷新。',
      'shell.openedFolder': '已在主机上打开文件夹。', 'shell.tabsLabel': '图像工坊分区',
      'shell.tabs.create': '创作', 'shell.tabs.library': '图库', 'shell.tabs.compare': '对比', 'shell.tabs.settings': '设置',
      'shell.loadingTitle': '正在加载图像工坊', 'shell.loadingBody': '正在读取图库与模型配置…',
      'shell.bootErrorTitle': '图像工坊无法加载。', 'shell.bootErrorBody': '面板暂时连不上本地接口。', 'shell.retry': '重试',
      'errors.network': '无法连接图像工坊接口。', 'errors.unknown': '出了点问题。', 'errors.copyFailed': '复制到剪贴板失败。',
      'common.close': '关闭', 'common.cancel': '取消', 'common.copy': '复制', 'common.copied': '已复制',
      'common.retry': '重试', 'common.save': '保存', 'common.saved': '已保存', 'common.loading': '加载中…',
      'common.download': '下载', 'common.image': '图片', 'common.auto': '自动', 'common.seconds': '{count} 秒', 'common.ms': '{count} 毫秒',
      'create.provider': '服务商', 'create.model': '模型', 'create.aspect': '画幅', 'create.size': '分辨率',
      'create.quality': '质量', 'create.qualityLow': '低', 'create.qualityMedium': '中', 'create.qualityHigh': '高',
      'create.count': '数量', 'create.seed': '种子', 'create.decreaseCount': '减少数量', 'create.increaseCount': '增加数量',
      'create.seedPlaceholder': '随机', 'create.randomSeed': '随机种子',
      'create.reference': '参考图', 'create.chooseRef': '选择', 'create.refLimit': '最多 {count} 张参考图',
      'create.refNone': '可选：从图库中选择。', 'create.refRemove': '移除参考图',
      'create.refUnsupported': '当前模型不支持参考图。', 'create.refFull': '最多添加 {count} 张参考图。',
      'create.refAlready': '这张图已经是参考图了。', 'create.refAdded': '已添加参考图。',
      'create.refPickerTitle': '选择参考图', 'create.refPickerEmpty': '图库还是空的。',
      'create.refPickerEmptyBody': '先生成一张图片，再把它作为参考图。', 'create.refPickerDone': '完成',
      'create.savedTo': '保存到 {dir}', 'create.reveal': '打开',
      'create.promptPlaceholder': '描述你想要的画面：主体、光线、镜头、氛围。',
      'create.negativeToggle': '反向提示词', 'create.negativePlaceholder': '需要避免的内容：文字、多余手指、硬闪光……',
      'create.chars': '{count} 个字符', 'create.recentPrompts': '最近提示词', 'create.recentEmpty': '还没有历史提示词。',
      'create.recentError': '无法加载历史提示词。', 'create.generate': '生成', 'create.generateN': '生成 {count} 张',
      'create.generating': '生成中…', 'create.generatingWith': '正在使用 {model} 生成…',
      'create.elapsed': '{seconds} 秒', 'create.cancel': '取消', 'create.cancelled': '已取消生成。',
      'create.errorTitle': '生成失败', 'create.errorUnconfigured': '在设置中为 {provider} 添加密钥。',
      'create.errorAuth': '服务商拒绝了密钥，请在设置中检查。', 'create.openSettings': '打开设置', 'create.dismiss': '忽略',
      'create.emptyTitle': '你的第一张图片，只差一句提示词。',
      'create.emptyBody': '在上方描述画面并点击生成，所有成品都会自动入库。',
      'create.example1': '哑光黑咖啡机置于洞石台面上的电影感产品照，清晨窗光，浅景深，85mm',
      'create.example2': '爱琴海沿岸的手绘水彩地图，灰蓝与赭石晕染，纸张纹理，无文字',
      'create.example3': '摆满植物的微型单间公寓等距剖面图，柔和日光，柔彩色调，干净的矢量阴影',
      'create.noModels': '该服务商还没有配置模型。', 'create.notConfigured': '尚未配置密钥', 'create.beta': '测试版',
      'create.images': '{count} 张', 'create.imageOne': '1 张', 'create.charOne': '1 个字符',
      'create.openImage': '打开第 {n} 张图片', 'create.copyPrompt': '复制提示词',
      'create.favorite': '收藏', 'create.unfavorite': '取消收藏', 'create.useAsRef': '用作参考图',
      'create.details': '详情', 'create.download': '下载图片', 'create.lightboxLabel': '图片预览',
      'create.prevImage': '上一张', 'create.nextImage': '下一张', 'create.imageCounter': '{index} / {total}',
      'create.seedValue': '种子 {seed}', 'create.seedRandom': '随机种子', 'create.downloadStarted': '开始下载。',
      'library.search': '搜索提示词', 'library.allProviders': '全部服务商', 'library.favorites': '收藏',
      'library.sort': '排序', 'library.newest': '最新', 'library.oldest': '最早', 'library.count': '{total} 条', 'library.countOne': '1 条',
      'library.itemOne': '1 条', 'library.itemMany': '{count} 条', 'library.imageOne': '1 张图片', 'library.imageMany': '{count} 张图片',
      'library.loadMore': '加载更多', 'library.loading': '正在加载图库…', 'library.errorTitle': '无法加载图库。',
      'library.emptyTitle': '这里还没有内容。', 'library.emptyBody': '生成的图片会自动出现在这里。',
      'library.emptyFilteredTitle': '没有匹配结果。', 'library.emptyFilteredBody': '换个关键词试试，或清除筛选。',
      'library.openCreate': '去创作', 'library.clearFilters': '清除筛选', 'library.untitled': '未命名', 'library.dirFallback': '图库',
      'library.openItem': '打开图片详情', 'library.openItemNamed': '打开图片详情：{prompt}', 'library.toggleFavorite': '切换收藏',
      'library.provider': '服务商', 'library.model': '模型', 'library.aspectSize': '画幅 / 尺寸',
      'library.quality': '质量', 'library.seed': '种子', 'library.latency': '耗时', 'library.created': '创建时间',
      'library.source': '来源', 'library.sourceUi': '面板', 'library.sourceAgent': '智能体', 'library.sourceCompare': '对比',
      'library.prompt': '提示词', 'library.revisedPrompt': '服务商改写', 'library.tags': '标签',
      'library.tagPlaceholder': '输入标签后回车', 'library.removeTag': '移除标签 {tag}', 'library.rating': '评分',
      'library.rate': '{n} 星', 'library.notes': '备注', 'library.notesPlaceholder': '给这张图的私人备注',
      'library.saveNotes': '保存备注', 'library.notesSaved': '备注已保存。', 'library.delete': '删除',
      'library.deleteConfirm': '确认删除？', 'library.deleteBody': '这会从图库中删除图片文件。', 'library.deleting': '删除中…',
      'library.deleted': '图片已删除。', 'library.revealPath': '显示文件路径', 'library.pathCopied': '文件路径已复制。',
      'library.detailTitle': '图片详情', 'library.previous': '上一条', 'library.next': '下一条',
      'library.loadingDetail': '正在加载详情…', 'library.errorDetail': '无法加载这张图片。',
      'library.thumb': '查看第 {n} 张', 'library.imageAlt': '图片：{prompt}',
      'compare.targetsTitle': '对比目标', 'compare.targetsHint': '选择 2–4 组「服务商 · 模型」。',
      'compare.maxTargets': '最多对比 {count} 个目标。', 'compare.run': '开始对比', 'compare.running': '对比中…',
      'compare.cancel': '取消', 'compare.needTwo': '请至少选择两个目标。', 'compare.needPrompt': '请先写提示词。',
      'compare.params': '使用默认值：{aspect} · {quality} · 每个目标 {count} 张', 'compare.errorTitle': '对比失败',
      'compare.columnSucceeded': '完成', 'compare.columnFailed': '失败', 'compare.noImage': '没有返回图片。',
      'compare.rating': '给结果评分', 'compare.openInLibrary': '在图库中打开', 'compare.usePrompt': '再用此提示词',
      'compare.savedRuns': '历史对比', 'compare.noRuns': '还没有对比记录。',
      'compare.noRunsBody': '用一句提示词对比两个模型，记录会出现在这里。', 'compare.runsError': '无法加载历史对比。',
      'compare.loadingRuns': '正在加载对比记录…', 'compare.emptyTitle': '并排对比模型。',
      'compare.emptyBody': '选择两个以上目标，把同一句提示词发给它们。',
      'compare.selectedCount': '已选 {count} / {max}', 'compare.latency': '{ms} 毫秒', 'compare.focusPrompt': '写提示词',
      'compare.resultStatus': '结果状态', 'compare.openSettings': '检查服务商设置',
      'settings.providersTitle': '服务商', 'settings.providersHint': '密钥保存在 DeepSeek Harness 凭据库中，不会写入设置文件。',
      'settings.status.connected': '已连接', 'settings.status.noKey': '无密钥', 'settings.status.notConfigured': '未配置',
      'settings.status.fromEnv': '来自环境变量：{name}', 'settings.keyLabel': 'API 密钥',
      'settings.keyPlaceholder': '粘贴密钥', 'settings.save': '保存', 'settings.saving': '保存中…',
      'settings.clear': '清除', 'settings.clearing': '清除中…', 'settings.keySaved': '已保存 {provider} 的密钥。',
      'settings.keyCleared': '已清除 {provider} 的密钥。', 'settings.test': '测试连接', 'settings.testing': '测试中…',
      'settings.testOk': '连接正常 · {ms} 毫秒', 'settings.testFailed': '测试失败',
      'settings.defaultModel': '默认模型', 'settings.endpoint': '接口地址', 'settings.endpointPlaceholder': 'https://…',
      'settings.saveEndpoint': '保存接口地址', 'settings.endpointSaved': '接口地址已保存。',
      'settings.docs': '文档', 'settings.getKey': '获取密钥', 'settings.modelUpdated': '默认模型已保存。',
      'settings.libraryTitle': '图库', 'settings.path': '目录', 'settings.pathMissing': '暂不可用。',
      'settings.items': '条目', 'settings.images': '图片', 'settings.bytes': '占用空间',
      'settings.reveal': '在访达中显示', 'settings.openFolder': '打开文件夹', 'settings.refresh': '刷新',
      'settings.refreshed': '图库已刷新。', 'settings.defaultsTitle': '默认值', 'settings.defaultProvider': '服务商', 'settings.modelAuto': '服务商默认',
      'settings.defaultModelLabel': '模型', 'settings.defaultAspect': '画幅', 'settings.defaultQuality': '质量',
      'settings.ambientLabel': 'Google 凭据',
      'settings.vertexKeyLabel': 'Vertex Express API Key（可选）',
      'settings.vertexKeyHint': '留空则使用本机 ADC（与 DSH 的 google-vertex 共用）；填写后走 Express 模式，不需要 OAuth。',
      'settings.ambientError': '读取 Google 凭据失败（{code}）——通常是 macOS 没给「文稿」目录权限。直接把 Vertex Express API key 填在下面即可绕过。',
      'settings.ambientReady': '正在使用本机 Google 凭据（{source}）',
      'settings.ambientMissing': '没有找到 Google 凭据',
      'settings.ambientProject': '项目 {project}',
      'settings.ambientLocation': '区域 {location}',
      'settings.ambientHint': '与 DSH 的 google-vertex provider 共用同一套 ADC（GOOGLE_APPLICATION_CREDENTIALS 或 gcloud），这里不需要再填密钥。',
      'settings.status.ambient': '已连接 · {source}',
      'settings.defaultCount': '数量', 'settings.qualityAuto': '服务商默认', 'settings.defaultsSaved': '默认值已保存。',
      'settings.aboutTitle': '关于', 'settings.aboutLine': '图像工坊 {version}',
      'settings.aboutBody': 'API 密钥由 DeepSeek Harness 凭据库保存，绝不会写入磁盘上的设置文件。',
      'settings.emptyProviders': '没有可用的服务商。', 'settings.emptyProvidersBody': '主机没有返回任何适配器。',
      'settings.errorSave': '无法保存设置。', 'settings.refreshFailed': '刷新失败。', 'settings.revealFailed': '无法打开文件夹。',
      'settings.keySource': '密钥来源', 'settings.defaultModelHint': '用于新生成请求，可随时更改。',
      'settings.kindSync': '即时', 'settings.kindAsync': '后台任务'
    }

    const en = {
      'panel.title': 'Image Studio',
      'shell.subtitle': '{items} saved · {images} images', 'shell.loadingSub': 'Opening your studio…',
      'shell.openFolder': 'Open folder', 'shell.refresh': 'Refresh', 'shell.refreshed': 'Library refreshed.',
      'shell.openedFolder': 'Folder opened on the host.', 'shell.tabsLabel': 'Image Studio sections',
      'shell.tabs.create': 'Create', 'shell.tabs.library': 'Library', 'shell.tabs.compare': 'Compare', 'shell.tabs.settings': 'Settings',
      'shell.loadingTitle': 'Loading Image Studio', 'shell.loadingBody': 'Reading your library and provider setup…',
      'shell.bootErrorTitle': 'Image Studio could not load.', 'shell.bootErrorBody': 'The panel could not reach its local API.', 'shell.retry': 'Retry',
      'errors.network': 'Could not reach the Image Studio API.', 'errors.unknown': 'Something went wrong.', 'errors.copyFailed': 'Could not copy to the clipboard.',
      'common.close': 'Close', 'common.cancel': 'Cancel', 'common.copy': 'Copy', 'common.copied': 'Copied',
      'common.retry': 'Retry', 'common.save': 'Save', 'common.saved': 'Saved', 'common.loading': 'Loading…',
      'common.download': 'Download', 'common.image': 'Image', 'common.auto': 'Auto', 'common.seconds': '{count} s', 'common.ms': '{count} ms',
      'create.provider': 'Provider', 'create.model': 'Model', 'create.aspect': 'Aspect', 'create.size': 'Resolution',
      'create.quality': 'Quality', 'create.qualityLow': 'Low', 'create.qualityMedium': 'Medium', 'create.qualityHigh': 'High',
      'create.count': 'Count', 'create.seed': 'Seed', 'create.decreaseCount': 'Decrease count', 'create.increaseCount': 'Increase count',
      'create.seedPlaceholder': 'Random', 'create.randomSeed': 'Random seed',
      'create.reference': 'Reference image', 'create.chooseRef': 'Choose', 'create.refLimit': 'Up to {count} references',
      'create.refNone': 'Optional — pick from your library.', 'create.refRemove': 'Remove reference',
      'create.refUnsupported': 'This model does not accept reference images.', 'create.refFull': 'You can add up to {count} references.',
      'create.refAlready': 'That image is already a reference.', 'create.refAdded': 'Reference added.',
      'create.refPickerTitle': 'Choose reference images', 'create.refPickerEmpty': 'Nothing in the library yet.',
      'create.refPickerEmptyBody': 'Generate an image first, then use it as a reference.', 'create.refPickerDone': 'Done',
      'create.savedTo': 'Saved to {dir}', 'create.reveal': 'Open',
      'create.promptPlaceholder': 'Describe the image you want — subject, light, lens, mood.',
      'create.negativeToggle': 'Negative prompt', 'create.negativePlaceholder': 'What to avoid — text, extra fingers, harsh flash…',
      'create.chars': '{count} characters', 'create.recentPrompts': 'Recent prompts', 'create.recentEmpty': 'No recent prompts yet.',
      'create.recentError': 'Could not load recent prompts.', 'create.generate': 'Generate', 'create.generateN': 'Generate {count}',
      'create.generating': 'Generating…', 'create.generatingWith': 'Generating with {model}…',
      'create.elapsed': '{seconds}s', 'create.cancel': 'Cancel', 'create.cancelled': 'Generation cancelled.',
      'create.errorTitle': 'Generation failed', 'create.errorUnconfigured': 'Add a key in Settings to use {provider}.',
      'create.errorAuth': 'The provider rejected the key. Check it in Settings.', 'create.openSettings': 'Open settings', 'create.dismiss': 'Dismiss',
      'create.emptyTitle': 'Your first image is one prompt away.',
      'create.emptyBody': 'Describe a scene above and press Generate. Everything you make lands in the library.',
      'create.example1': 'Cinematic product shot of a matte black espresso machine on travertine, morning window light, shallow depth of field, 85mm',
      'create.example2': 'Hand-painted watercolor map of the Aegean coast, muted indigo and ochre washes, paper texture, no text',
      'create.example3': 'Isometric cutaway of a tiny plant-filled studio apartment, soft daylight, pastel palette, clean vector shading',
      'create.noModels': 'This provider has no models configured.', 'create.notConfigured': 'No key yet', 'create.beta': 'beta',
      'create.images': '{count} images', 'create.imageOne': '1 image', 'create.charOne': '1 character',
      'create.openImage': 'Open image {n}', 'create.copyPrompt': 'Copy prompt',
      'create.favorite': 'Favorite', 'create.unfavorite': 'Remove from favorites', 'create.useAsRef': 'Use as reference',
      'create.details': 'Details', 'create.download': 'Download image', 'create.lightboxLabel': 'Image preview',
      'create.prevImage': 'Previous image', 'create.nextImage': 'Next image', 'create.imageCounter': '{index} / {total}',
      'create.seedValue': 'Seed {seed}', 'create.seedRandom': 'Random seed', 'create.downloadStarted': 'Download started.',
      'library.search': 'Search prompts', 'library.allProviders': 'All providers', 'library.favorites': 'Favorites',
      'library.sort': 'Sort', 'library.newest': 'Newest', 'library.oldest': 'Oldest', 'library.count': '{total} items', 'library.countOne': '1 item',
      'library.itemOne': '1 item', 'library.itemMany': '{count} items', 'library.imageOne': '1 image', 'library.imageMany': '{count} images',
      'library.loadMore': 'Load more', 'library.loading': 'Loading library…', 'library.errorTitle': 'Could not load the library.',
      'library.emptyTitle': 'Nothing here yet.', 'library.emptyBody': 'Generated images land here automatically.',
      'library.emptyFilteredTitle': 'No matches.', 'library.emptyFilteredBody': 'Try a different search or clear the filters.',
      'library.openCreate': 'Open Create', 'library.clearFilters': 'Clear filters', 'library.untitled': 'Untitled', 'library.dirFallback': 'library',
      'library.openItem': 'Open image details', 'library.openItemNamed': 'Open image details: {prompt}', 'library.toggleFavorite': 'Toggle favorite',
      'library.provider': 'Provider', 'library.model': 'Model', 'library.aspectSize': 'Aspect / size',
      'library.quality': 'Quality', 'library.seed': 'Seed', 'library.latency': 'Latency', 'library.created': 'Created',
      'library.source': 'Source', 'library.sourceUi': 'Panel', 'library.sourceAgent': 'Agent', 'library.sourceCompare': 'Compare',
      'library.prompt': 'Prompt', 'library.revisedPrompt': 'Revised by provider', 'library.tags': 'Tags',
      'library.tagPlaceholder': 'Add a tag and press Enter', 'library.removeTag': 'Remove tag {tag}', 'library.rating': 'Rating',
      'library.rate': 'Rate {n}', 'library.notes': 'Notes', 'library.notesPlaceholder': 'Private notes for this image',
      'library.saveNotes': 'Save notes', 'library.notesSaved': 'Notes saved.', 'library.delete': 'Delete',
      'library.deleteConfirm': 'Delete?', 'library.deleteBody': 'This removes the image files from the library.', 'library.deleting': 'Deleting…',
      'library.deleted': 'Image deleted.', 'library.revealPath': 'Reveal file path', 'library.pathCopied': 'File path copied.',
      'library.detailTitle': 'Image details', 'library.previous': 'Previous item', 'library.next': 'Next item',
      'library.loadingDetail': 'Loading details…', 'library.errorDetail': 'Could not load this item.',
      'library.thumb': 'Show image {n}', 'library.imageAlt': 'Image: {prompt}',
      'compare.targetsTitle': 'Targets', 'compare.targetsHint': 'Pick 2–4 provider · model pairs.',
      'compare.maxTargets': 'You can compare up to {count} targets.', 'compare.run': 'Run comparison', 'compare.running': 'Comparing…',
      'compare.cancel': 'Cancel', 'compare.needTwo': 'Choose at least two targets.', 'compare.needPrompt': 'Write a prompt first.',
      'compare.params': 'Uses defaults: {aspect} · {quality} · {count} image per target', 'compare.errorTitle': 'Comparison failed',
      'compare.columnSucceeded': 'Done', 'compare.columnFailed': 'Failed', 'compare.noImage': 'No image returned.',
      'compare.rating': 'Rate result', 'compare.openInLibrary': 'Open in Library', 'compare.usePrompt': 'Use prompt again',
      'compare.savedRuns': 'Saved comparisons', 'compare.noRuns': 'No comparisons yet.',
      'compare.noRunsBody': 'Run one prompt across two models and it will show up here.', 'compare.runsError': 'Could not load saved comparisons.',
      'compare.loadingRuns': 'Loading comparisons…', 'compare.emptyTitle': 'Compare models side by side.',
      'compare.emptyBody': 'Pick two or more targets, then run the same prompt through all of them.',
      'compare.selectedCount': '{count} of {max} selected', 'compare.latency': '{ms} ms', 'compare.focusPrompt': 'Write a prompt',
      'compare.resultStatus': 'Result status', 'compare.openSettings': 'Check provider settings',
      'settings.providersTitle': 'Providers', 'settings.providersHint': 'Keys live in the DeepSeek Harness credential store; the settings file never holds them.',
      'settings.status.connected': 'Connected', 'settings.status.noKey': 'No key', 'settings.status.notConfigured': 'Not configured',
      'settings.status.fromEnv': 'From environment: {name}', 'settings.keyLabel': 'API key',
      'settings.keyPlaceholder': 'Paste a key', 'settings.save': 'Save', 'settings.saving': 'Saving…',
      'settings.clear': 'Clear', 'settings.clearing': 'Clearing…', 'settings.keySaved': 'Key saved for {provider}.',
      'settings.keyCleared': 'Key cleared for {provider}.', 'settings.test': 'Test connection', 'settings.testing': 'Testing…',
      'settings.testOk': 'OK · {ms} ms', 'settings.testFailed': 'Test failed',
      'settings.defaultModel': 'Default model', 'settings.endpoint': 'Endpoint', 'settings.endpointPlaceholder': 'https://…',
      'settings.saveEndpoint': 'Save endpoint', 'settings.endpointSaved': 'Endpoint saved.',
      'settings.docs': 'Docs', 'settings.getKey': 'Get a key', 'settings.modelUpdated': 'Default model saved.',
      'settings.libraryTitle': 'Library', 'settings.path': 'Folder', 'settings.pathMissing': 'Not available yet.',
      'settings.items': 'Items', 'settings.images': 'Images', 'settings.bytes': 'On disk',
      'settings.reveal': 'Reveal in Finder', 'settings.openFolder': 'Open folder', 'settings.refresh': 'Refresh',
      'settings.refreshed': 'Library refreshed.', 'settings.defaultsTitle': 'Defaults', 'settings.defaultProvider': 'Provider', 'settings.modelAuto': 'Provider default',
      'settings.defaultModelLabel': 'Model', 'settings.defaultAspect': 'Aspect', 'settings.defaultQuality': 'Quality',
      'settings.ambientLabel': 'Google credential',
      'settings.vertexKeyLabel': 'Vertex Express API key (optional)',
      'settings.vertexKeyHint': 'Leave empty to use this machine\u2019s ADC (shared with DSH\u2019s google-vertex provider); paste a key to use Express mode instead \u2014 no OAuth.',
      'settings.ambientError': 'Could not read the Google credential ({code}) \u2014 usually macOS has not granted access to the Documents folder. Paste a Vertex Express API key below to bypass it.',
      'settings.ambientReady': 'Using this machine\u2019s Google credentials ({source})',
      'settings.ambientMissing': 'No Google credentials found',
      'settings.ambientProject': 'Project {project}',
      'settings.ambientLocation': 'Region {location}',
      'settings.ambientHint': 'Shares the same ADC as DSH\u2019s google-vertex provider (GOOGLE_APPLICATION_CREDENTIALS or gcloud) \u2014 there is no key to paste here.',
      'settings.status.ambient': 'Connected · {source}',
      'settings.defaultCount': 'Count', 'settings.qualityAuto': 'Provider default', 'settings.defaultsSaved': 'Defaults saved.',
      'settings.aboutTitle': 'About', 'settings.aboutLine': 'Image Studio {version}',
      'settings.aboutBody': 'API keys are stored by the DeepSeek Harness credential store and are never written to the settings file on disk.',
      'settings.emptyProviders': 'No providers are available.', 'settings.emptyProvidersBody': 'The host did not report any adapters.',
      'settings.errorSave': 'Could not save settings.', 'settings.refreshFailed': 'Could not refresh.', 'settings.revealFailed': 'Could not open the folder.',
      'settings.keySource': 'Key source', 'settings.defaultModelHint': 'Used to prefill new generations; you can change it any time.',
      'settings.kindSync': 'Direct', 'settings.kindAsync': 'Job'
    }
    //#endregion

    //#region Small helpers
    /** Console logging that cannot itself throw in a degraded host. */
    function safeLog(reason) {
      try {
        if (typeof console !== 'undefined' && console.warn) console.warn('[image-studio]', reason)
      } catch (ignored) {
        /* nothing to do */
      }
    }

    let uidCounter = 0
    /** Stable per-component id (label htmlFor) without depending on React.useId. */
    function useUid(prefix) {
      const ref = useRef(null)
      if (ref.current === null) {
        uidCounter += 1
        ref.current = prefix + '-' + uidCounter
      }
      return ref.current
    }

    function clamp(value, min, max) {
      const n = Number(value)
      if (!isFinite(n)) return min
      return Math.min(max, Math.max(min, n))
    }
    function clampCount(value) {
      return Math.round(clamp(value || 1, 1, 4))
    }
    function uniq(list) {
      const seen = {}
      const out = []
      ;(Array.isArray(list) ? list : []).forEach((item) => {
        const key = String(item)
        if (!key || seen[key]) return
        seen[key] = true
        out.push(item)
      })
      return out
    }
    function basename(path) {
      const text = String(path || '')
      const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
      return cut >= 0 ? text.slice(cut + 1) : text
    }
    function joinPath(dir, rel) {
      const root = String(dir || '')
      const rest = String(rel || '')
      if (!root) return rest
      if (!rest) return root
      const sep = root.indexOf('\\') >= 0 && root.indexOf('/') < 0 ? '\\' : '/'
      return root.replace(/[\\/]+$/, '') + sep + rest.replace(/^[\\/]+/, '')
    }
    function formatNumber(value) {
      const n = Number(value)
      if (!isFinite(n)) return '0'
      try {
        return n.toLocaleString()
      } catch (reason) {
        return String(n)
      }
    }
    function formatBytes(value) {
      let n = Number(value)
      if (!isFinite(n) || n < 0) n = 0
      if (n < 1024) return Math.round(n) + ' B'
      const units = ['KB', 'MB', 'GB', 'TB']
      let index = -1
      do {
        n = n / 1024
        index += 1
      } while (n >= 1024 && index < units.length - 1)
      return (n >= 10 ? Math.round(n) : n.toFixed(1)) + ' ' + units[index]
    }
    function formatDate(ms) {
      if (!ms) return '—'
      try {
        return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
      } catch (reason) {
        try {
          return new Date(ms).toLocaleString()
        } catch (ignored) {
          return '—'
        }
      }
    }
    function formatTime(ms) {
      if (!ms) return ''
      try {
        return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      } catch (reason) {
        return ''
      }
    }
    function pluralCount(count, oneKey, manyKey) {
      return Number(count) === 1 ? tt(oneKey) : tt(manyKey, { count: formatNumber(count) })
    }
    function itemCountLabel(total) {
      return Number(total) === 1 ? tt('library.countOne') : tt('library.count', { total: formatNumber(total) })
    }
    function formatLatency(ms) {
      const n = Number(ms)
      if (!isFinite(n) || n <= 0) return '—'
      return n < 1000 ? tt('common.ms', { count: Math.round(n) }) : tt('common.seconds', { count: (n / 1000).toFixed(1) })
    }
    async function copyText(text) {
      try {
        if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.writeText) return false
        await navigator.clipboard.writeText(String(text === null || text === undefined ? '' : text))
        return true
      } catch (reason) {
        return false
      }
    }

    /** Host image endpoint for one item image (SPEC.md section 3). */
    function fileUrl(itemId, index, thumb) {
      return API_BASE + '/file/' + encodeURIComponent(String(itemId)) + '/' + Number(index || 0) + (thumb ? '?thumb=1' : '')
    }
    function downloadUrl(itemId, index) {
      return API_BASE + '/download/' + encodeURIComponent(String(itemId)) + '/' + Number(index || 0)
    }
    /** CSS aspect-ratio value from a stored width/height pair. */
    function imageRatioStyle(image) {
      const width = Number(image && image.width)
      const height = Number(image && image.height)
      return { aspectRatio: width > 0 && height > 0 ? width + ' / ' + height : '1 / 1' }
    }
    /** Tiny proportional rectangle dimensions for an aspect chip. */
    function ratioStyle(aspect) {
      const match = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/.exec(String(aspect || ''))
      const width = match ? Number(match[1]) : 1
      const height = match ? Number(match[2]) : 1
      const ratio = width > 0 && height > 0 ? width / height : 1
      const box = 16
      return ratio >= 1
        ? { width: box + 'px', height: Math.max(5, Math.round(box / ratio)) + 'px' }
        : { width: Math.max(5, Math.round(box * ratio)) + 'px', height: box + 'px' }
    }
    function kindLabel(kind) {
      if (kind === 'sync') return tt('settings.kindSync')
      if (kind === 'async') return tt('settings.kindAsync')
      return kind ? String(kind) : ''
    }
    function qualityLabel(value) {
      if (!value) return tt('settings.qualityAuto')
      if (value === 'low') return tt('create.qualityLow')
      if (value === 'medium') return tt('create.qualityMedium')
      if (value === 'high') return tt('create.qualityHigh')
      return String(value)
    }

    /** Provider/model helpers over the bootstrap payload. */
    function modelList(provider) {
      return provider && Array.isArray(provider.models) ? provider.models : []
    }
    function findProvider(providers, id) {
      return (Array.isArray(providers) ? providers : []).find((p) => p && p.id === id) || null
    }
    function providerLabel(providers, id) {
      const provider = findProvider(providers, id)
      return provider ? provider.label || provider.id : String(id || '')
    }
    function modelLabel(providers, providerId, modelId) {
      const provider = findProvider(providers, providerId)
      const model = provider ? modelList(provider).find((m) => m && m.id === modelId) : null
      return model ? model.label || model.id : String(modelId || '')
    }
    function providerInitials(label) {
      const words = String(label || '?').trim().split(/\s+/).filter(Boolean)
      if (!words.length) return '?'
      if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
      return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase()
    }
    /** Which status pill a ProviderView should show. */
    function statusOfProvider(provider) {
      if (!provider) return 'noKey'
      if (provider.configured) {
        return provider.source && /^[A-Z0-9_]+$/.test(String(provider.source)) ? 'fromEnv' : 'connected'
      }
      if (provider.configurableBaseUrl && !provider.baseUrl) return 'notConfigured'
      return 'noKey'
    }
    function qualityList(providers) {
      const out = []
      ;(Array.isArray(providers) ? providers : []).forEach((provider) => {
        modelList(provider).forEach((model) => {
          uniq(model && model.qualities).forEach((q) => out.push(q))
        })
      })
      return uniq(out)
    }
    function aspectList(providers, providerId) {
      const out = []
      ;(Array.isArray(providers) ? providers : []).forEach((provider) => {
        if (providerId && provider.id !== providerId) return
        modelList(provider).forEach((model) => {
          uniq(model && model.aspects).forEach((a) => out.push(a))
        })
      })
      return uniq(out)
    }
    function pickAspect(model, defaults) {
      const list = model && Array.isArray(model.aspects) ? model.aspects : []
      if (!list.length) return ''
      if (defaults && list.indexOf(defaults.aspect) >= 0) return defaults.aspect
      return list[0]
    }
    function pickQuality(model, defaults) {
      const list = model && Array.isArray(model.qualities) ? model.qualities : []
      if (!list.length) return ''
      if (defaults && list.indexOf(defaults.quality) >= 0) return defaults.quality
      return list[0]
    }
    function pickSize(model, defaults) {
      const list = model && Array.isArray(model.sizes) ? model.sizes : []
      if (!list.length) return ''
      if (defaults && list.indexOf(defaults.size) >= 0) return defaults.size
      return list[0]
    }
    function defaultModelOf(provider) {
      const models = modelList(provider)
      if (!models.length) return ''
      if (provider && provider.defaultModel && models.some((m) => m && m.id === provider.defaultModel)) return provider.defaultModel
      return models[0].id
    }
    function targetKey(providerId, modelId) {
      return String(providerId) + '\u0000' + String(modelId)
    }
    /** Every selectable provider · model pair, with display labels. */
    function targetPairs(providers) {
      const out = []
      ;(Array.isArray(providers) ? providers : []).forEach((provider) => {
        if (!provider || !provider.id) return
        modelList(provider).forEach((model) => {
          if (!model || !model.id) return
          out.push({
            provider: provider.id,
            model: model.id,
            key: targetKey(provider.id, model.id),
            label: (provider.label || provider.id) + ' · ' + (model.label || model.id)
          })
        })
      })
      return out
    }
    function normalizeTargets(list, providers) {
      const known = {}
      targetPairs(providers).forEach((pair) => {
        known[pair.key] = pair
      })
      const out = []
      const seen = {}
      ;(Array.isArray(list) ? list : []).forEach((target) => {
        if (!target || !target.provider || !target.model) return
        const key = targetKey(target.provider, target.model)
        if (!known[key] || seen[key]) return
        seen[key] = true
        out.push({ provider: target.provider, model: target.model })
      })
      return out.slice(0, MAX_COMPARE)
    }

    /** Error helpers. */
    function errMessage(reason) {
      if (!reason) return tt('errors.unknown')
      if (typeof reason === 'string') return reason
      return String(reason.message || tt('errors.unknown'))
    }
    function isAuthError(reason) {
      if (!reason) return false
      if (reason.status === 401 || reason.status === 403) return true
      const text = String(reason.message || '') + ' ' + String(reason.hint || '')
      return /(^|\b)(401|403|unauthori[sz]ed|forbidden|invalid api key|api[ _-]?key|permission denied)\b/i.test(text)
    }
    function hintFor(reason, provider) {
      const parts = []
      if (reason && reason.hint) parts.push(String(reason.hint))
      if (provider && provider.configured === false) {
        parts.push(tt('create.errorUnconfigured', { provider: provider.label || provider.id }))
      } else if (isAuthError(reason)) {
        parts.push(tt('create.errorAuth'))
      }
      return parts.join(' ')
    }
    function needsSettings(reason, provider) {
      return !!((provider && provider.configured === false) || isAuthError(reason))
    }

    /** Normalize the bootstrap payload so a partially-filled host cannot crash the UI. */
    function normalizeBootstrap(payload) {
      const raw = payload && typeof payload === 'object' ? payload : {}
      const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {}
      const providers = Array.isArray(raw.providers) ? raw.providers : []
      const defaults = Object.assign(
        { provider: '', model: '', aspect: '', quality: '', count: 1 },
        settings.defaults || {},
        raw.defaults || {}
      )
      defaults.count = clampCount(defaults.count)
      const library = Object.assign({ dir: '', itemCount: 0, imageCount: 0, bytes: 0 }, raw.library || {})
      let compareTargets = Array.isArray(raw.compareTargets) ? raw.compareTargets : []
      if (!compareTargets.length && settings.ui && Array.isArray(settings.ui.compareTargets)) compareTargets = settings.ui.compareTargets
      return { version: raw.version || '', library, providers, defaults, settings, compareTargets }
    }

    /** Platform facts used for shortcut + folder wording. */
    const IS_MAC = (function () {
      try {
        return /mac|iphone|ipad/i.test(String(navigator.platform || ''))
      } catch (reason) {
        return false
      }
    })()
    const SHORTCUT_HINT = IS_MAC ? '\u2318\u21B5' : 'Ctrl\u21B5'
    //#endregion

    //#region API client
    function apiError(message, code, hint, status) {
      const error = new Error(message || tt('errors.unknown'))
      error.code = code || ''
      error.hint = hint || ''
      error.status = status || 0
      return error
    }
    function qs(query) {
      if (!query) return ''
      const parts = []
      Object.keys(query).forEach((key) => {
        const value = query[key]
        if (value === undefined || value === null || value === '') return
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
      })
      return parts.length ? '?' + parts.join('&') : ''
    }
    /**
     * JSON fetch against the host half. `credentials: same-origin` keeps the
     * Harness session. Failures throw an Error carrying code/hint/status.
     */
    async function api(path, options) {
      const opts = options || {}
      const url = API_BASE + path + qs(opts.query)
      const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } }
      if (opts.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(opts.body)
      }
      if (opts.signal) init.signal = opts.signal
      let response
      try {
        response = await fetch(url, init)
      } catch (reason) {
        if (reason && reason.name === 'AbortError') throw reason
        throw apiError(tt('errors.network'), 'network', '', 0)
      }
      let text = ''
      try {
        text = await response.text()
      } catch (reason) {
        text = ''
      }
      let payload = null
      if (text) {
        try {
          payload = JSON.parse(text)
        } catch (reason) {
          payload = null
        }
      }
      if (!response.ok) {
        const info = payload && payload.error && typeof payload.error === 'object' ? payload.error : {}
        const message = info.message || (text ? text.slice(0, 400) : '') || 'HTTP ' + response.status
        throw apiError(String(message), info.code || 'http_error', info.hint || '', response.status)
      }
      return payload
    }
    //#endregion

    //#region Hooks
    function useDebounced(value, delay) {
      const [debounced, setDebounced] = useState(value)
      useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), delay)
        return () => clearTimeout(timer)
      }, [value, delay])
      return debounced
    }
    function useEscape(onClose, active) {
      const handler = useRef(onClose)
      handler.current = onClose
      useEffect(() => {
        if (!active) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          if (handler.current) handler.current()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [active])
    }
    function useOutsideClose(ref, open, onClose) {
      const handler = useRef(onClose)
      handler.current = onClose
      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (!ref.current || ref.current.contains(event.target)) return
          if (handler.current) handler.current()
        }
        document.addEventListener('pointerdown', onDown, true)
        return () => document.removeEventListener('pointerdown', onDown, true)
      }, [open])
    }
    function useModalFocus(ref) {
      useEffect(() => {
        const previous = typeof document !== 'undefined' ? document.activeElement : null
        const node = ref.current
        if (node && typeof node.focus === 'function') {
          try {
            node.focus()
          } catch (reason) {
            /* ignore */
          }
        }
        return () => {
          try {
            if (previous && typeof previous.focus === 'function') previous.focus()
          } catch (reason) {
            /* ignore */
          }
        }
      }, [])
    }
    function useShortcut(enabled, handler) {
      const latest = useRef(handler)
      latest.current = handler
      useEffect(() => {
        if (!enabled) return undefined
        const onKey = (event) => {
          if (event.isComposing) return
          if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return
          event.preventDefault()
          if (latest.current) latest.current()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [enabled])
    }
    /** Auto-growing textarea: min/max heights are px, never negative. */
    function AutoTextarea(props) {
      const ownRef = useRef(null)
      const textareaRef = props.inputRef || ownRef
      useEffect(() => {
        const node = textareaRef.current
        if (!node) return
        node.style.height = 'auto'
        const min = props.minHeight || 110
        const max = props.maxHeight || 320
        const next = Math.min(max, Math.max(min, node.scrollHeight))
        node.style.height = next + 'px'
      }, [props.value, props.minHeight, props.maxHeight])
      return h('textarea', {
        ref: textareaRef,
        className: 'isx-textarea' + (props.small ? ' isx-textareaSmall' : ''),
        value: props.value,
        rows: props.rows || 1,
        placeholder: props.placeholder,
        spellCheck: false,
        disabled: !!props.disabled,
        'aria-label': props.ariaLabel,
        onKeyDown: props.onKeyDown,
        onChange: (event) => {
          if (props.onChange) props.onChange(event.target.value)
        }
      })
    }
    //#endregion

    //#region Icons (16x16, stroke currentColor, aria-hidden)
    function Svg(props) {
      const size = props.size || 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: props.viewBox || '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: props.strokeWidth || 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        className: props.className || undefined
      }, props.children)
    }
    function IconSpark(props) {
      return h(Svg, props, h('path', { d: 'M8 2.3l1.25 3.2 3.2 1.25-3.2 1.25L8 11.2 6.75 8 3.55 6.75l3.2-1.25z' }), h('path', { d: 'M12.6 11.4l.45 1.15 1.15.45-1.15.45-.45 1.15-.45-1.15-1.15-.45 1.15-.45z' }))
    }
    function IconStudio(props) {
      return h(Svg, props,
        h('rect', { x: '1.8', y: '2.6', width: '12.4', height: '10.8', rx: '2' }),
        h('circle', { cx: '5.3', cy: '6', r: '1' }),
        h('path', { d: 'M2.4 11.7l3.1-3a1.2 1.2 0 0 1 1.65 0l1.9 1.85' }),
        h('path', { d: 'M11.3 4.6l.55 1.35 1.35.55-1.35.55-.55 1.35-.55-1.35-1.35-.55 1.35-.55z' }))
    }
    function IconRefresh(props) {
      return h(Svg, props, h('path', { d: 'M13 8a5 5 0 1 1-1.55-3.6' }), h('path', { d: 'M13 2.7v2.6h-2.6' }))
    }
    function IconFolder(props) {
      return h(Svg, props, h('path', { d: 'M2 5.1A1.1 1.1 0 0 1 3.1 4h2.5l1.25 1.4h5.05A1.1 1.1 0 0 1 13 6.5v5.3a1.1 1.1 0 0 1-1.1 1.1H3.1A1.1 1.1 0 0 1 2 11.8z' }))
    }
    function IconX(props) {
      return h(Svg, props, h('path', { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6' }))
    }
    function IconChevron(props) {
      return h(Svg, props, h('path', { d: 'M4.2 6.4L8 10.2l3.8-3.8' }))
    }
    function IconSearch(props) {
      return h(Svg, props, h('circle', { cx: '7.1', cy: '7.1', r: '4.2' }), h('path', { d: 'M10.3 10.3l3.1 3.1' }))
    }
    function IconStar(props) {
      return h(Svg, props, h('path', { d: 'M8 2.1l1.78 3.6 3.97.58-2.87 2.8.68 3.96L8 11.2l-3.56 1.84.68-3.96L2.25 6.28l3.97-.58z', fill: props.filled ? 'currentColor' : 'none' }))
    }
    function IconDownload(props) {
      return h(Svg, props, h('path', { d: 'M8 2.8v7.5' }), h('path', { d: 'M5.1 7.5L8 10.4l2.9-2.9' }), h('path', { d: 'M3 13.1h10' }))
    }
    function IconCopy(props) {
      return h(Svg, props, h('rect', { x: '5.6', y: '5.6', width: '7', height: '7.2', rx: '1.5' }), h('path', { d: 'M10.4 5.6V4.1A1.5 1.5 0 0 0 8.9 2.6H4.1a1.5 1.5 0 0 0-1.5 1.5v4.8a1.5 1.5 0 0 0 1.5 1.5h1.5' }))
    }
    function IconImage(props) {
      return h(Svg, props, h('rect', { x: '2', y: '3', width: '12', height: '10', rx: '2' }), h('circle', { cx: '5.6', cy: '6.4', r: '1' }), h('path', { d: 'M2.5 11.4l3.5-3.2 2.3 2.1 2.2-1.9 2.9 2.6' }))
    }
    function IconTrash(props) {
      return h(Svg, props, h('path', { d: 'M2.9 4.4h10.2' }), h('path', { d: 'M6.3 4.4V2.9h3.4v1.5' }), h('path', { d: 'M4.5 4.4l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8' }), h('path', { d: 'M6.8 6.8v4.1M9.2 6.8v4.1' }))
    }
    function IconDice(props) {
      return h(Svg, props,
        h('rect', { x: '2.4', y: '2.4', width: '11.2', height: '11.2', rx: '2.2' }),
        h('circle', { cx: '5.6', cy: '5.6', r: '.75', fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: '10.4', cy: '5.6', r: '.75', fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: '8', cy: '8', r: '.75', fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: '5.6', cy: '10.4', r: '.75', fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: '10.4', cy: '10.4', r: '.75', fill: 'currentColor', stroke: 'none' }))
    }
    function IconCheck(props) {
      return h(Svg, props, h('path', { d: 'M3 8.4l3.2 3.2L13 4.7' }))
    }
    function IconAlert(props) {
      return h(Svg, props, h('path', { d: 'M8 2.5l6 10.6H2z' }), h('path', { d: 'M8 6.2v3.2' }), h('path', { d: 'M8 11.7v.01' }))
    }
    function IconArrowLeft(props) {
      return h(Svg, props, h('path', { d: 'M12.2 8H3.8' }), h('path', { d: 'M7 4.3L3.3 8 7 11.7' }))
    }
    function IconArrowRight(props) {
      return h(Svg, props, h('path', { d: 'M3.8 8h8.4' }), h('path', { d: 'M9 4.3L12.7 8 9 11.7' }))
    }
    function IconPlus(props) {
      return h(Svg, props, h('path', { d: 'M8 3.4v9.2M3.4 8h9.2' }))
    }
    function IconMinus(props) {
      return h(Svg, props, h('path', { d: 'M3.4 8h9.2' }))
    }
    function IconExternal(props) {
      return h(Svg, props, h('path', { d: 'M6.6 3.5H3.5v9h9V9.4' }), h('path', { d: 'M9 2.5h4.5V7' }), h('path', { d: 'M13.5 2.5L7.4 8.6' }))
    }
    function IconInfo(props) {
      return h(Svg, props, h('circle', { cx: '8', cy: '8', r: '5.8' }), h('path', { d: 'M8 7.2v4' }), h('path', { d: 'M8 5v.01' }))
    }
    function IconClock(props) {
      return h(Svg, props, h('circle', { cx: '8', cy: '8', r: '5.7' }), h('path', { d: 'M8 4.9V8l2.1 1.3' }))
    }
    const I = {
      spark: IconSpark, studio: IconStudio, refresh: IconRefresh, folder: IconFolder, x: IconX,
      chevron: IconChevron, search: IconSearch, star: IconStar, download: IconDownload, copy: IconCopy,
      image: IconImage, trash: IconTrash, dice: IconDice, check: IconCheck, alert: IconAlert,
      arrowLeft: IconArrowLeft, arrowRight: IconArrowRight, plus: IconPlus, minus: IconMinus,
      external: IconExternal, info: IconInfo, clock: IconClock
    }
    //#endregion

    //#region UI primitives
    function Btn(props) {
      const { icon, iconProps, variant, size, busy, children, className } = props
      const rest = {}
      Object.keys(props).forEach((key) => {
        if (['icon', 'iconProps', 'variant', 'size', 'busy', 'children', 'className'].indexOf(key) < 0) rest[key] = props[key]
      })
      return h('button', Object.assign({
        type: 'button',
        className: 'isx-btn' + (className ? ' ' + className : ''),
        'data-variant': variant || 'secondary',
        'data-size': size || 'md'
      }, rest),
      busy ? h('span', { className: 'isx-spin' + (variant === 'primary' ? ' isx-spinOnBrand' : '') }) : icon ? h(icon, iconProps || { size: 14 }) : null,
      children !== undefined && children !== null ? h('span', { className: 'isx-btnLabel' }, children) : null)
    }
    function IconBtn(props) {
      const { icon, label, active, iconProps, busy, className } = props
      const rest = {}
      Object.keys(props).forEach((key) => {
        if (['icon', 'label', 'active', 'iconProps', 'busy', 'className'].indexOf(key) < 0) rest[key] = props[key]
      })
      return h('button', Object.assign({
        type: 'button',
        className: 'isx-iconBtn' + (className ? ' ' + className : ''),
        'aria-label': label,
        title: label,
        'aria-pressed': active === undefined ? undefined : !!active
      }, rest),
      busy ? h('span', { className: 'isx-spin' }) : h(icon, iconProps || { size: 15 }))
    }
    function IconLink(props) {
      return h('a', {
        className: 'isx-iconBtn',
        href: props.href,
        download: props.download ? '' : undefined,
        target: props.download ? undefined : '_blank',
        rel: props.download ? undefined : 'noreferrer noopener',
        'aria-label': props.label,
        title: props.label
      }, h(props.icon, { size: 15 }))
    }
    function Pill(props) {
      return h('span', { className: 'isx-pill', 'data-tone': props.tone || 'idle', title: props.title || undefined }, props.children)
    }
    function Spinner(props) {
      return h('span', { className: 'isx-spin' + (props.onBrand ? ' isx-spinOnBrand' : ''), 'aria-hidden': 'true' })
    }
    function Field(props) {
      return h('div', { className: 'isx-field' + (props.className ? ' ' + props.className : '') },
        props.label
          ? props.id
            ? h('label', { className: 'isx-fieldLabel', htmlFor: props.id }, props.label)
            : h('span', { className: 'isx-fieldLabel' }, props.label)
          : null,
        props.children,
        props.hint ? h('p', { className: 'isx-hint' }, props.hint) : null)
    }
    function Select(props) {
      return h('select', {
        id: props.id,
        className: 'isx-select' + (props.className ? ' ' + props.className : ''),
        value: props.value === undefined || props.value === null ? '' : props.value,
        disabled: !!props.disabled,
        'aria-label': props.ariaLabel || undefined,
        title: props.title || undefined,
        onChange: (event) => {
          if (props.onChange) props.onChange(event.target.value)
        }
      }, (props.options || []).map((option) => h('option', { key: String(option.value), value: option.value, disabled: !!option.disabled }, option.label)))
    }
    function TextInput(props) {
      const { className } = props
      const rest = {}
      Object.keys(props).forEach((key) => {
        if (key !== 'className') rest[key] = props[key]
      })
      return h('input', Object.assign({ type: 'text', className: 'isx-input' + (className ? ' ' + className : '') }, rest))
    }
    function Stars(props) {
      const value = clamp(Number(props.value) || 0, 0, 5)
      return h('div', { className: 'isx-stars', role: 'group', 'aria-label': props.label || tt('library.rating') },
        [1, 2, 3, 4, 5].map((n) => h('button', {
          key: n,
          type: 'button',
          className: 'isx-starBtn',
          'aria-label': tt('library.rate', { n }),
          title: tt('library.rate', { n }),
          'aria-pressed': n <= value,
          disabled: !!props.disabled,
          onClick: () => {
            if (props.onRate) props.onRate(value === n ? 0 : n)
          }
        }, h(I.star, { size: props.size || 16, filled: n <= value }))))
    }
    function EmptyState(props) {
      return h('div', { className: 'isx-empty' },
        h('div', { className: 'isx-emptyGlyph', 'aria-hidden': 'true' }, props.glyph || h(I.spark, { size: 26 })),
        h('h2', { className: 'isx-emptyTitle' }, props.title),
        props.body ? h('p', { className: 'isx-emptyBody' }, props.body) : null,
        props.children ? h('div', { className: 'isx-emptyActions' }, props.children) : null)
    }
    function ErrorCard(props) {
      const copyValue = [props.message, props.hint].filter(Boolean).join('\n')
      return h('div', { className: 'isx-errorCard', role: 'alert' },
        h('div', { className: 'isx-errorHead' },
          h(I.alert, { size: 16 }),
          h('span', { className: 'isx-errorTitle' }, props.title || tt('create.errorTitle')),
          h('span', { className: 'isx-grow' }),
          props.onDismiss ? h(IconBtn, { icon: I.x, label: tt('common.close'), onClick: props.onDismiss }) : null),
        h('p', { className: 'isx-errorMsg' }, props.message),
        props.hint ? h('p', { className: 'isx-errorHint' }, props.hint) : null,
        h('div', { className: 'isx-errorActions' },
          h(Btn, { icon: I.copy, onClick: () => props.onCopy && props.onCopy(copyValue) }, tt('common.copy')),
          props.onSettings && props.needSettings ? h(Btn, { icon: I.external, onClick: props.onSettings }, tt('create.openSettings')) : null,
          props.onDismiss ? h(Btn, { onClick: props.onDismiss }, props.dismissLabel || tt('create.dismiss')) : null))
    }
    function Modal(props) {
      const ref = useRef(null)
      useModalFocus(ref)
      useEscape(props.onClose, true)
      return h('div', {
        className: 'isx-scrim',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) props.onClose()
        }
      },
      h('div', {
        className: 'isx-modal',
        ref: ref,
        tabIndex: -1,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': props.title,
        style: props.width ? { maxWidth: props.width + 'px' } : undefined
      },
      h('div', { className: 'isx-modalHead' },
        h('h2', { className: 'isx-modalTitle' }, props.title),
        h(IconBtn, { icon: I.x, label: tt('common.close'), onClick: props.onClose })),
      h('div', { className: 'isx-modalBody' }, props.children)))
    }
    function Img(props) {
      const [failed, setFailed] = useState(false)
      useEffect(() => {
        setFailed(false)
      }, [props.src])
      const src = failed && props.fallback ? props.fallback : props.src
      return h('img', {
        className: props.className || undefined,
        src: src,
        alt: props.alt || '',
        loading: props.eager ? 'eager' : 'lazy',
        decoding: 'async',
        draggable: false,
        style: props.style,
        onError: () => {
          if (!failed) setFailed(true)
        }
      })
    }
    //#endregion

    //#region Prompt editor (shared by Create and Compare)
    function truncate(text, length) {
      const value = String(text === null || text === undefined ? '' : text)
      if (value.length <= length) return value
      return value.slice(0, Math.max(0, length - 1)) + '\u2026'
    }
    /** Recent prompts chip cloud, loaded from /prompts on first disclosure. */
    function RecentPrompts(props) {
      const [open, setOpen] = useState(false)
      const [state, setState] = useState({ status: 'idle', items: [], error: '' })
      const wrapRef = useRef(null)
      useOutsideClose(wrapRef, open, () => setOpen(false))
      useEscape(() => setOpen(false), open)
      useEffect(() => {
        if (!open) return undefined
        let live = true
        setState((current) => ({ status: 'loading', items: current.items, error: '' }))
        api('/prompts', { query: { limit: 20 } })
          .then((data) => {
            if (!live) return
            setState({ status: 'ready', items: data && Array.isArray(data.prompts) ? data.prompts : [], error: '' })
          })
          .catch((reason) => {
            if (!live) return
            setState({ status: 'error', items: [], error: errMessage(reason) })
          })
        return () => {
          live = false
        }
      }, [open])
      return h('span', { className: 'isx-recent', ref: wrapRef },
        h('button', {
          type: 'button',
          className: 'isx-toggle',
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value)
        }, h(I.clock, { size: 13 }), tt('create.recentPrompts'), h(I.chevron, { size: 12, className: open ? 'isx-chevronOpen' : '' })),
        open ? h('div', { className: 'isx-popover', role: 'dialog', 'aria-label': tt('create.recentPrompts') },
          state.status === 'loading' ? h('div', { className: 'isx-popoverStatus' }, h(Spinner, null), tt('common.loading')) : null,
          state.status === 'error' ? h('div', { className: 'isx-popoverStatus isx-popoverError' }, state.error) : null,
          state.status === 'ready' && !state.items.length ? h('div', { className: 'isx-popoverStatus' }, tt('create.recentEmpty')) : null,
          state.status === 'ready' && state.items.length
            ? h('div', { className: 'isx-popoverChips' }, state.items.map((entry, index) => h('button', {
              key: String(index),
              type: 'button',
              className: 'isx-chip isx-chipPrompt',
              title: entry && entry.prompt,
              onClick: () => {
                if (props.onPick && entry) props.onPick(entry.prompt || '')
                setOpen(false)
              }
            }, truncate(entry && entry.prompt, 96))))
            : null) : null)
    }
    function PromptEditor(props) {
      return h('div', { className: 'isx-promptEditor' },
        h(AutoTextarea, {
          value: props.value || '',
          onChange: props.onChange,
          placeholder: props.placeholder || tt('create.promptPlaceholder'),
          minHeight: props.minHeight || 110,
          maxHeight: props.maxHeight || 320,
          inputRef: props.textareaRef,
          ariaLabel: tt('library.prompt'),
          disabled: props.disabled
        }),
        h('div', { className: 'isx-promptMeta' },
          h('span', { className: 'isx-count' }, String(props.value || '').length === 1
            ? tt('create.charOne')
            : tt('create.chars', { count: String(props.value || '').length })),
          h('span', { className: 'isx-metaDot', 'aria-hidden': 'true' }, '\u00b7'),
          h(RecentPrompts, { onPick: props.onChange }),
          h('span', { className: 'isx-grow' }),
          h('button', {
            type: 'button',
            className: 'isx-toggle',
            'aria-pressed': !!props.showNegative,
            onClick: props.onToggleNegative
          }, h(props.showNegative ? I.minus : I.plus, { size: 13 }), tt('create.negativeToggle'))),
        props.showNegative ? h(AutoTextarea, {
          value: props.negative || '',
          onChange: props.onNegativeChange,
          placeholder: tt('create.negativePlaceholder'),
          minHeight: 44,
          maxHeight: 120,
          small: true,
          ariaLabel: tt('create.negativeToggle')
        }) : null)
    }
    //#endregion

    //#region Create tab
    function ShotCard(props) {
      const item = props.item
      const image = item.images && item.images[props.index] ? item.images[props.index] : {}
      const alt = tt('library.imageAlt', { prompt: truncate(item.prompt, 70) })
      return h('figure', { className: 'isx-shot' },
        h('button', {
          type: 'button',
          className: 'isx-shotOpen',
          'aria-label': tt('create.openImage', { n: props.index + 1 }),
          onClick: () => props.onOpen(item, props.index)
        },
        h('div', { className: 'isx-plate', style: imageRatioStyle(image) },
          h(Img, {
            src: fileUrl(item.id, props.index, true),
            fallback: fileUrl(item.id, props.index, false),
            alt: alt,
            className: 'isx-plateImg'
          }))),
        h('figcaption', { className: 'isx-shotBar' },
          h(IconLink, { icon: I.download, href: downloadUrl(item.id, props.index), download: true, label: tt('create.download') }),
          h(IconBtn, { icon: I.copy, label: tt('create.copyPrompt'), onClick: () => props.onCopy(item.prompt) }),
          h(IconBtn, {
            icon: I.star,
            iconProps: { size: 15, filled: !!item.favorite },
            label: item.favorite ? tt('create.unfavorite') : tt('create.favorite'),
            active: !!item.favorite,
            onClick: () => props.onToggleFavorite(item)
          }),
          h(IconBtn, { icon: I.image, label: tt('create.useAsRef'), onClick: () => props.onUseRef(item) }),
          h(IconBtn, { icon: I.info, label: tt('create.details'), onClick: () => props.onDetails(item) })))
    }
    function Round(props) {
      const item = props.item
      const images = item && Array.isArray(item.images) ? item.images : []
      const columns = images.length <= 2 ? Math.max(images.length, 1) : 2
      const params = item.params || {}
      return h('section', { className: 'isx-round' },
        h('div', { className: 'isx-roundHead' },
          h('span', { className: 'isx-roundTitle' }, modelLabel(props.providers, item.provider, item.model)),
          h('span', { className: 'isx-metaText' }, [
            params.aspect,
            params.size,
            images.length === 1 ? tt('create.imageOne') : tt('create.images', { count: images.length }),
            formatTime(item.createdAt)
          ].filter(Boolean).join(' \u00b7 '))),
        h('div', { className: 'isx-grid', 'data-count': String(columns) },
          images.map((image, index) => h(ShotCard, {
            key: (image && image.file) || String(index),
            item: item,
            index: index,
            providers: props.providers,
            onOpen: props.onOpen,
            onCopy: props.onCopy,
            onToggleFavorite: props.onToggleFavorite,
            onUseRef: props.onUseRef,
            onDetails: props.onDetails
          }))))
    }
    function CreateTab(props) {
      const providers = props.providers || []
      const defaults = props.defaults || {}
      const libraryDir = props.libraryDir || ''
      const [providerId, setProviderId] = useState('')
      const [modelId, setModelId] = useState('')
      const [aspect, setAspect] = useState('')
      const [size, setSize] = useState('')
      const [quality, setQuality] = useState('')
      const [count, setCount] = useState(1)
      const [seedText, setSeedText] = useState('')
      const [refs, setRefs] = useState([])
      const [refItems, setRefItems] = useState({})
      const [prompt, setPrompt] = useState('')
      const [negative, setNegative] = useState('')
      const [showNegative, setShowNegative] = useState(false)
      const [running, setRunning] = useState(null)
      const [elapsed, setElapsed] = useState(0)
      const [rounds, setRounds] = useState([])
      const [error, setError] = useState(null)
      const [pickerOpen, setPickerOpen] = useState(false)
      const [lightbox, setLightbox] = useState(null)
      const [revealing, setRevealing] = useState(false)
      const initialized = useRef(false)
      const abortRef = useRef(null)
      const runToken = useRef(0)
      const promptRef = useRef(null)
      const workRef = useRef(null)
      const refCache = useRef({})
      const uid = useUid('create')

      const provider = findProvider(providers, providerId) || providers[0] || null
      const models = modelList(provider)
      const model = models.find((entry) => entry.id === modelId) || models[0] || null
      const aspects = model && Array.isArray(model.aspects) ? model.aspects : []
      const sizes = model && Array.isArray(model.sizes) ? model.sizes : []
      const qualities = model && Array.isArray(model.qualities) ? model.qualities : []
      const effAspect = aspects.indexOf(aspect) >= 0 ? aspect : pickAspect(model, defaults)
      const effSize = sizes.indexOf(size) >= 0 ? size : pickSize(model, defaults)
      const effQuality = qualities.indexOf(quality) >= 0 ? quality : pickQuality(model, defaults)
      const countValue = clampCount(count)
      const maxRefs = model && model.supportsRefs
        ? Math.max(1, Math.min(MAX_REFS, model.maxRefs > 0 ? model.maxRefs : MAX_REFS))
        : 0
      const isBeta = !!(model && model.beta) || !!(provider && provider.beta)
      const promptReady = String(prompt || '').trim().length > 0
      const canGenerate = !!provider && !!model && promptReady && !running
      const shortcut = SHORTCUT_HINT

      // Seed the left rail from settings defaults exactly once per mount.
      useEffect(() => {
        if (initialized.current || !providers.length) return
        const first = (defaults.provider && findProvider(providers, defaults.provider)) || providers[0]
        const nextModels = modelList(first)
        const wanted = nextModels.find((entry) => entry.id === defaults.model) || nextModels.find((entry) => entry.id === defaultModelOf(first)) || nextModels[0] || null
        setProviderId(first.id)
        setModelId(wanted ? wanted.id : '')
        setAspect(pickAspect(wanted, defaults))
        setSize(pickSize(wanted, defaults))
        setQuality(pickQuality(wanted, defaults))
        setCount(clampCount(defaults.count))
        initialized.current = true
      }, [providers, defaults])

      const ensureRefItem = useCallback((id) => {
        if (!id || refCache.current[id]) return
        refCache.current[id] = { id: id }
        api('/items/' + encodeURIComponent(id))
          .then((data) => {
            if (data && data.item) {
              refCache.current[id] = data.item
              setRefItems(Object.assign({}, refCache.current))
            }
          })
          .catch(() => {
            delete refCache.current[id]
          })
      }, [])

      // Apply a cross-tab preset (reference image / prompt) once the model is known.
      useEffect(() => {
        const preset = props.pendingCreate
        if (!preset) return
        if (preset.prompt) {
          setPrompt(preset.prompt)
          if (promptRef.current) {
            try {
              promptRef.current.focus()
            } catch (reason) {
              /* ignore */
            }
          }
        }
        if (preset.refId) {
          if (!model) return
          if (!model.supportsRefs) {
            props.showToast(tt('create.refUnsupported'))
          } else {
            setRefs((current) => (current.indexOf(preset.refId) >= 0 ? current : current.concat([preset.refId]).slice(-maxRefs)))
            ensureRefItem(preset.refId)
          }
        }
        if (props.onPresetConsumed) props.onPresetConsumed()
      }, [props.pendingCreate, model])

      useEffect(() => {
        return () => {
          if (abortRef.current) abortRef.current.abort()
        }
      }, [])

      useEffect(() => {
        if (!running) {
          setElapsed(0)
          return undefined
        }
        const started = running.startedAt
        setElapsed(0)
        const timer = setInterval(() => {
          setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)))
        }, 500)
        return () => clearInterval(timer)
      }, [running])

      function changeProvider(nextId) {
        const nextProvider = findProvider(providers, nextId)
        const nextModels = modelList(nextProvider)
        const nextModelId = defaultModelOf(nextProvider)
        const nextModel = nextModels.find((entry) => entry.id === nextModelId) || nextModels[0] || null
        setProviderId(nextId)
        setModelId(nextModel ? nextModel.id : '')
        setAspect(pickAspect(nextModel, defaults))
        setSize(pickSize(nextModel, defaults))
        setQuality(pickQuality(nextModel, defaults))
        trimRefsFor(nextModel)
      }
      function trimRefsFor(nextModel) {
        if (!nextModel || !nextModel.supportsRefs) {
          setRefs([])
          return
        }
        const cap = Math.max(1, Math.min(MAX_REFS, nextModel.maxRefs > 0 ? nextModel.maxRefs : MAX_REFS))
        setRefs((current) => (current.length > cap ? current.slice(0, cap) : current))
      }
      function changeModel(nextId) {
        const nextModel = models.find((entry) => entry.id === nextId) || null
        setModelId(nextId)
        setAspect(pickAspect(nextModel, defaults))
        setSize(pickSize(nextModel, defaults))
        setQuality(pickQuality(nextModel, defaults))
        trimRefsFor(nextModel)
      }
      function addRef(id) {
        if (!model || !model.supportsRefs) {
          props.showToast(tt('create.refUnsupported'))
          return
        }
        if (refs.indexOf(id) >= 0) {
          props.showToast(tt('create.refAlready'))
          return
        }
        if (refs.length >= maxRefs) {
          props.showToast(tt('create.refFull', { count: maxRefs }))
          return
        }
        setRefs(refs.concat([id]).slice(-maxRefs))
        ensureRefItem(id)
      }
      function removeRef(id) {
        setRefs(refs.filter((entry) => entry !== id))
      }
      function useAsReference(item) {
        const mapped = { id: item.id, prompt: item.prompt, images: item.images, favorite: item.favorite, params: item.params, provider: item.provider, model: item.model }
        refCache.current[item.id] = mapped
        setRefItems(Object.assign({}, refCache.current))
        addRef(item.id)
      }
      function toggleFavorite(item) {
        api('/items/' + encodeURIComponent(item.id), { method: 'PATCH', body: { favorite: !item.favorite } })
          .then((data) => {
            const next = data && data.item
            if (!next) return
            setRounds((current) => current.map((round) => (round.id === next.id ? next : round)))
          })
          .catch((reason) => props.showToast(errMessage(reason)))
      }
      function copyPrompt(text) {
        copyText(text).then((ok) => props.showToast(ok ? tt('common.copied') : tt('errors.copyFailed')))
      }
      function doGenerate() {
        if (!canGenerate || !provider || !model) return
        const body = {
          provider: provider.id,
          model: model.id,
          prompt: String(prompt || '').trim(),
          negativePrompt: String(negative || '').trim(),
          aspect: effAspect || '',
          size: effSize || '',
          quality: effQuality || '',
          count: countValue,
          save: true
        }
        const seed = String(seedText || '').trim()
        if (seed && /^\d+$/.test(seed)) body.seed = Number(seed)
        if (model.supportsRefs && refs.length) body.refs = refs.slice(0, maxRefs)
        const controller = new AbortController()
        const token = runToken.current + 1
        runToken.current = token
        abortRef.current = controller
        setError(null)
        setRunning({ startedAt: Date.now(), modelLabel: model.label || model.id })
        api('/generate', { method: 'POST', body: body, signal: controller.signal })
          .then((data) => {
            if (runToken.current !== token) return
            const item = data && data.item
            if (!item) throw apiError(tt('errors.unknown'), 'empty', '', 0)
            if (item.status === 'failed') {
              setError({ message: item.error || tt('errors.unknown'), hint: '', status: 0 })
              return
            }
            setRounds((current) => [item].concat(current))
            if (workRef.current) workRef.current.scrollTop = 0
            if (props.reloadBootstrap) props.reloadBootstrap()
          })
          .catch((reason) => {
            if (runToken.current !== token) return
            if (reason && reason.name === 'AbortError') return
            setError(reason)
          })
          .finally(() => {
            if (runToken.current !== token) return
            abortRef.current = null
            setRunning(null)
          })
      }
      function cancelGenerate() {
        runToken.current += 1
        if (abortRef.current) abortRef.current.abort()
        abortRef.current = null
        setRunning(null)
        props.showToast(tt('create.cancelled'))
      }
      function revealFolder() {
        if (!libraryDir) return
        setRevealing(true)
        api('/reveal', { method: 'POST', body: { path: libraryDir } })
          .then((data) => {
            const opened = !(data && data.ok === false)
            props.showToast(opened ? tt('shell.openedFolder') : tt('settings.revealFailed'), opened ? 'info' : 'error')
          })
          .catch((reason) => props.showToast(errMessage(reason), 'error'))
          .finally(() => setRevealing(false))
      }

      useShortcut(!!props.active, () => {
        if (pickerOpen || lightbox) return
        doGenerate()
      })

      if (!providers.length) {
        return h('div', { className: 'isx-create isx-createEmpty' },
          h(EmptyState, {
            glyph: h(I.studio, { size: 28 }),
            title: tt('settings.emptyProviders'),
            body: tt('settings.emptyProvidersBody')
          }, h(Btn, { variant: 'primary', onClick: props.onOpenSettings }, tt('create.openSettings'))))
      }

      const lightboxRound = lightbox ? rounds.find((round) => round.id === lightbox.roundId) : null
      const providerOptions = providers.map((entry) => ({
        value: entry.id,
        label: entry.label + (entry.configured ? '' : ' \u00b7 ' + tt('create.notConfigured'))
      }))
      const modelOptions = models.map((entry) => ({ value: entry.id, label: entry.label || entry.id }))

      return h('div', { className: 'isx-create' },
        h('div', { className: 'isx-rail' },
          h(Field, { label: tt('create.provider'), id: uid + '-provider' },
            h('div', { className: 'isx-selectWrap' },
              h('span', { className: 'isx-dot', 'data-state': provider && provider.configured ? 'on' : 'off', 'aria-hidden': 'true' }),
              h(Select, { id: uid + '-provider', value: provider ? provider.id : '', onChange: changeProvider, options: providerOptions }))),
          h('div', { className: 'isx-field' },
            h('div', { className: 'isx-fieldLabelRow' },
              h('label', { className: 'isx-fieldLabel', htmlFor: uid + '-model' }, tt('create.model')),
              isBeta ? h('span', { className: 'isx-tag isx-tagBeta' }, tt('create.beta')) : null),
            models.length
              ? h(Select, { id: uid + '-model', value: model ? model.id : '', onChange: changeModel, options: modelOptions })
              : h('p', { className: 'isx-hint' }, tt('create.noModels')),
            model && model.note ? h('p', { className: 'isx-hint' }, model.note) : null),
          aspects.length ? h('div', { className: 'isx-field' },
            h('span', { className: 'isx-fieldLabel' }, tt('create.aspect')),
            h('div', { className: 'isx-chips' }, aspects.map((entry) => h('button', {
              key: entry,
              type: 'button',
              className: 'isx-chipBtn',
              'aria-pressed': effAspect === entry,
              onClick: () => setAspect(entry)
            }, h('span', { className: 'isx-ratio', 'aria-hidden': 'true' }, h('span', { className: 'isx-ratioRect', style: ratioStyle(entry) })), h('span', null, entry))))) : null,
          sizes.length ? h(Field, { label: tt('create.size'), id: uid + '-size' },
            h(Select, { id: uid + '-size', value: effSize, onChange: setSize, options: sizes.map((entry) => ({ value: entry, label: entry })) })) : null,
          qualities.length ? h(Field, { label: tt('create.quality'), id: uid + '-quality' },
            h(Select, { id: uid + '-quality', value: effQuality, onChange: setQuality, options: qualities.map((entry) => ({ value: entry, label: qualityLabel(entry) })) })) : null,
          h(Field, { label: tt('create.count') },
            h('div', { className: 'isx-stepper' },
              h(IconBtn, { icon: I.minus, label: tt('create.decreaseCount'), disabled: countValue <= 1, onClick: () => setCount(clampCount(countValue - 1)) }),
              h('span', { className: 'isx-stepperValue', 'aria-live': 'polite' }, countValue),
              h(IconBtn, { icon: I.plus, label: tt('create.increaseCount'), disabled: countValue >= 4, onClick: () => setCount(clampCount(countValue + 1)) }))),
          h(Field, { label: tt('create.seed'), id: uid + '-seed' },
            h('div', { className: 'isx-inline' },
              h('input', {
                id: uid + '-seed',
                className: 'isx-input',
                type: 'number',
                min: 0,
                step: 1,
                value: seedText,
                placeholder: tt('create.seedPlaceholder'),
                onChange: (event) => setSeedText(event.target.value)
              }),
              h(IconBtn, {
                icon: I.dice,
                label: tt('create.randomSeed'),
                onClick: () => setSeedText(String(Math.floor(Math.random() * 2147483646) + 1))
              }))),
          model && model.supportsRefs ? h('div', { className: 'isx-field' },
            h('div', { className: 'isx-fieldLabelRow' },
              h('span', { className: 'isx-fieldLabel' }, tt('create.reference')),
              h('span', { className: 'isx-count' }, refs.length + ' / ' + maxRefs)),
            refs.length
              ? h('div', { className: 'isx-refChips' }, refs.map((id) => h('div', { key: id, className: 'isx-refChip' },
                refItems[id] && refItems[id].images && refItems[id].images.length
                  ? h(Img, { src: fileUrl(id, 0, true), fallback: fileUrl(id, 0, false), alt: '', className: 'isx-refThumb' })
                  : h('span', { className: 'isx-refThumb isx-refThumbEmpty', 'aria-hidden': 'true' }, h(I.image, { size: 12 })),
                h('span', { className: 'isx-refLabel', title: refItems[id] ? refItems[id].prompt : id }, refItems[id] ? truncate(refItems[id].prompt, 30) : truncate(id, 16)),
                h(IconBtn, { icon: I.x, label: tt('create.refRemove'), onClick: () => removeRef(id) }))))
              : h('p', { className: 'isx-hint' }, tt('create.refNone')),
            h(Btn, { icon: I.image, size: 'sm', onClick: () => setPickerOpen(true) }, tt('create.chooseRef'))) : null,
          h('div', { className: 'isx-railFoot' },
            h('span', { className: 'isx-metaText', title: libraryDir }, tt('create.savedTo', { dir: basename(libraryDir) || tt('library.dirFallback') })),
            h('button', { type: 'button', className: 'isx-link', onClick: revealFolder, disabled: !libraryDir || revealing }, tt('create.reveal')))),
        h('div', { className: 'isx-work', ref: workRef },
          h('div', { className: 'isx-card isx-promptCard' },
            h(PromptEditor, {
              value: prompt,
              onChange: setPrompt,
              showNegative: showNegative,
              negative: negative,
              onNegativeChange: setNegative,
              onToggleNegative: () => setShowNegative((value) => !value),
              textareaRef: promptRef,
              minHeight: 110,
              maxHeight: 320
            }),
            h('div', { className: 'isx-promptActions' },
              h('span', { className: 'isx-metaText' }, provider ? provider.label : ''),
              h('span', { className: 'isx-grow' }),
              h(Btn, {
                variant: 'primary',
                disabled: !canGenerate,
                busy: !!running,
                title: tt('create.generate') + ' (' + shortcut + ')',
                onClick: doGenerate
              },
              running ? tt('create.generating') : countValue > 1 ? tt('create.generateN', { count: countValue }) : tt('create.generate'),
              !running ? h('kbd', { className: 'isx-kbd', 'aria-hidden': 'true' }, shortcut) : null))),
          running ? h('div', { className: 'isx-status', role: 'status', 'aria-live': 'polite' },
            h(Spinner, null),
            h('span', { className: 'isx-statusText' }, tt('create.generatingWith', { model: running.modelLabel })),
            h('span', { className: 'isx-count' }, tt('create.elapsed', { seconds: elapsed })),
            h('span', { className: 'isx-grow' }),
            h(Btn, { size: 'sm', onClick: cancelGenerate }, tt('create.cancel'))) : null,
          error ? h(ErrorCard, {
            message: errMessage(error),
            hint: hintFor(error, provider),
            needSettings: needsSettings(error, provider),
            onSettings: props.onOpenSettings,
            onDismiss: () => setError(null),
            onCopy: (text) => copyText(text).then((ok) => props.showToast(ok ? tt('common.copied') : tt('errors.copyFailed')))
          }) : null,
          rounds.length
            ? rounds.map((round) => h(Round, {
              key: round.id,
              item: round,
              providers: providers,
              onOpen: (item, index) => setLightbox({ roundId: item.id, index: index }),
              onCopy: copyPrompt,
              onToggleFavorite: toggleFavorite,
              onUseRef: useAsReference,
              onDetails: (item) => props.onOpenLibrary(item.id)
            }))
            : !running ? h('div', { className: 'isx-emptyWrap' },
              h(EmptyState, {
                glyph: h(I.studio, { size: 30 }),
                title: tt('create.emptyTitle'),
                body: tt('create.emptyBody')
              },
              h('div', { className: 'isx-exampleRow' },
                [tt('create.example1'), tt('create.example2'), tt('create.example3')].map((example, index) => h('button', {
                  key: index,
                  type: 'button',
                  className: 'isx-chip isx-chipExample',
                  title: example,
                  onClick: () => {
                    setPrompt(example)
                    if (promptRef.current) {
                      try {
                        promptRef.current.focus()
                      } catch (reason) {
                        /* ignore */
                      }
                    }
                  }
                }, truncate(example, 84)))))) : null),
        pickerOpen ? h(RefPickerModal, {
          selected: refs,
          maxRefs: maxRefs,
          onToggle: (id) => {
            if (refs.indexOf(id) >= 0) removeRef(id)
            else addRef(id)
          },
          onClose: () => setPickerOpen(false)
        }) : null,
        lightbox && lightboxRound && lightboxRound.images && lightboxRound.images.length
          ? h(Lightbox, {
            item: lightboxRound,
            index: lightbox.index,
            providers: providers,
            onIndex: (index) => setLightbox({ roundId: lightboxRound.id, index: index }),
            onClose: () => setLightbox(null),
            onCopy: copyPrompt,
            onToggleFavorite: toggleFavorite,
            onUseRef: useAsReference
          }) : null)
    }
    //#endregion

    //#region Reference picker modal
    function RefPickerModal(props) {
      const [state, setState] = useState({ status: 'loading', items: [], error: null })
      const [nonce, setNonce] = useState(0)
      useEffect(() => {
        let live = true
        setState({ status: 'loading', items: [], error: null })
        api('/items', { query: { limit: 24, sort: 'newest' } })
          .then((data) => {
            if (!live) return
            setState({ status: 'ready', items: data && Array.isArray(data.items) ? data.items : [], error: null })
          })
          .catch((reason) => {
            if (!live) return
            setState({ status: 'error', items: [], error: errMessage(reason) })
          })
        return () => {
          live = false
        }
      }, [nonce])
      return h(Modal, { title: tt('create.refPickerTitle'), onClose: props.onClose, width: 580 },
        h('div', { className: 'isx-pickerTop' },
          h('span', { className: 'isx-hint' }, tt('create.refLimit', { count: props.maxRefs })),
          h('span', { className: 'isx-grow' }),
          h('span', { className: 'isx-count' }, props.selected.length + ' / ' + props.maxRefs)),
        state.status === 'loading' ? h('div', { className: 'isx-popoverStatus' }, h(Spinner, null), tt('common.loading')) : null,
        state.status === 'error' ? h('div', { className: 'isx-popoverStatus isx-popoverError' },
          h('span', null, state.error),
          h(Btn, { onClick: () => setNonce(nonce + 1) }, tt('common.retry'))) : null,
        state.status === 'ready' && !state.items.length ? h(EmptyState, {
          glyph: h(I.image, { size: 24 }),
          title: tt('create.refPickerEmpty'),
          body: tt('create.refPickerEmptyBody')
        }) : null,
        state.status === 'ready' && state.items.length ? h('div', { className: 'isx-pickGrid' }, state.items.map((item) => {
          const selected = props.selected.indexOf(item.id) >= 0
          return h('button', {
            key: item.id,
            type: 'button',
            className: 'isx-pickItem',
            'aria-pressed': selected,
            onClick: () => props.onToggle(item.id)
          },
          h('span', { className: 'isx-pickThumb' },
            h(Img, { src: fileUrl(item.id, 0, true), fallback: fileUrl(item.id, 0, false), alt: '', className: 'isx-pickImg' }),
            selected ? h('span', { className: 'isx-pickCheck' }, h(I.check, { size: 13 })) : null),
          h('span', { className: 'isx-pickPrompt' }, truncate(item.prompt || tt('library.untitled'), 64)))
        })) : null,
        h('div', { className: 'isx-modalFoot' }, h(Btn, { variant: 'primary', onClick: props.onClose }, tt('create.refPickerDone'))))
    }
    //#endregion

    //#region Lightbox
    function Lightbox(props) {
      const item = props.item
      const images = item && Array.isArray(item.images) ? item.images : []
      const total = images.length
      const index = clamp(Number(props.index) || 0, 0, Math.max(0, total - 1))
      const params = item.params || {}
      const ref = useRef(null)
      useModalFocus(ref)
      useEscape(props.onClose, true)
      useEffect(() => {
        const onKey = (event) => {
          if (total < 2) return
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const delta = event.key === 'ArrowLeft' ? -1 : 1
          props.onIndex((index + delta + total) % total)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [index, total])
      const caption = [
        modelLabel(props.providers, item.provider, item.model),
        params.aspect || params.size,
        params.seed !== null && params.seed !== undefined ? tt('create.seedValue', { seed: params.seed }) : tt('create.seedRandom'),
        tt('create.imageCounter', { index: index + 1, total: total })
      ].filter(Boolean).join(' \u00b7 ')
      return h('div', { className: 'isx-lbScrim', onMouseDown: (event) => { if (event.target === event.currentTarget) props.onClose() } },
        h('div', { className: 'isx-lb', ref: ref, tabIndex: -1, role: 'dialog', 'aria-modal': 'true', 'aria-label': tt('create.lightboxLabel') },
          h(IconBtn, { className: 'isx-lbClose', icon: I.x, label: tt('common.close'), onClick: props.onClose }),
          total > 1 ? h(IconBtn, {
            className: 'isx-lbNav isx-lbPrev',
            icon: I.arrowLeft,
            label: tt('create.prevImage'),
            onClick: () => props.onIndex((index - 1 + total) % total)
          }) : null,
          total > 1 ? h(IconBtn, {
            className: 'isx-lbNav isx-lbNext',
            icon: I.arrowRight,
            label: tt('create.nextImage'),
            onClick: () => props.onIndex((index + 1) % total)
          }) : null,
          h('div', { className: 'isx-lbStage' },
            h(Img, {
              src: fileUrl(item.id, index, false),
              alt: tt('library.imageAlt', { prompt: truncate(item.prompt, 90) }),
              className: 'isx-lbImg',
              eager: true
            })),
          h('div', { className: 'isx-lbBar' },
            h('div', { className: 'isx-lbCaption', title: caption }, caption),
            h('div', { className: 'isx-lbActions' },
              h(IconLink, { icon: I.download, href: downloadUrl(item.id, index), download: true, label: tt('create.download') }),
              h(IconBtn, { icon: I.copy, label: tt('create.copyPrompt'), onClick: () => props.onCopy(item.prompt) }),
              h(IconBtn, {
                icon: I.star,
                iconProps: { size: 15, filled: !!item.favorite },
                label: item.favorite ? tt('create.unfavorite') : tt('create.favorite'),
                active: !!item.favorite,
                onClick: () => props.onToggleFavorite(item)
              }),
              h(IconBtn, { icon: I.image, label: tt('create.useAsRef'), onClick: () => props.onUseRef(item) })))))
    }
    //#endregion

    //#region Library tab
    function sourceText(item) {
      const source = (item && item.source) || {}
      const kind = source.kind || 'ui'
      if (kind === 'agent') {
        const where = source.cwd || (source.sessionId ? truncate(source.sessionId, 22) : '')
        return tt('library.sourceAgent') + (where ? ' \u00b7 ' + where : '')
      }
      if (kind === 'compare') return tt('library.sourceCompare') + (source.runId ? ' \u00b7 ' + source.runId : '')
      return tt('library.sourceUi')
    }
    function DetailRow(props) {
      return h('div', { className: 'isx-fieldRow' },
        h('span', { className: 'isx-fieldKey' }, props.label),
        h('span', { className: 'isx-fieldVal', title: props.title || undefined }, props.children))
    }
    function LibraryCard(props) {
      const item = props.item
      const image = item.images && item.images[0] ? item.images[0] : null
      return h('div', { className: 'isx-libCard', 'data-selected': props.selected ? 'true' : undefined },
        h('button', {
          type: 'button',
          className: 'isx-libThumb',
          onClick: props.onOpen,
          'aria-label': tt('library.openItemNamed', { prompt: truncate(item.prompt || tt('library.untitled'), 60) })
        },
          h(Img, {
            src: fileUrl(item.id, 0, true),
            fallback: fileUrl(item.id, 0, false),
            alt: tt('library.imageAlt', { prompt: truncate(item.prompt, 60) }),
            className: 'isx-libImg'
          })),
        h(IconBtn, {
          className: 'isx-libFav',
          icon: I.star,
          iconProps: { size: 14, filled: !!item.favorite },
          label: tt('library.toggleFavorite'),
          active: !!item.favorite,
          onClick: () => props.onToggleFavorite(item)
        }),
        h('button', { type: 'button', className: 'isx-libFoot', onClick: props.onOpen },
          h('span', { className: 'isx-libPrompt', title: item.prompt || '' }, item.prompt || tt('library.untitled')),
          h('span', { className: 'isx-libMeta' }, [providerLabel(props.providers, item.provider), modelLabel(props.providers, item.provider, item.model)].filter(Boolean).join(' \u00b7 '))))
    }
    function DetailDrawer(props) {
      const [detail, setDetail] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [nonce, setNonce] = useState(0)
      const [imageIndex, setImageIndex] = useState(0)
      const [tagDraft, setTagDraft] = useState('')
      const [notesDraft, setNotesDraft] = useState('')
      const [notesDirty, setNotesDirty] = useState(false)
      const [notesSaved, setNotesSaved] = useState(false)
      const [savingNotes, setSavingNotes] = useState(false)
      const [confirmDelete, setConfirmDelete] = useState(false)
      const [deleting, setDeleting] = useState(false)
      const [patching, setPatching] = useState(false)
      const drawerRef = useRef(null)
      const notesQueue = useRef({ busy: false, next: null })
      const notesApi = useRef({ dirty: false, text: '', detail: null, save: null })
      const itemId = props.itemId
      const listIndex = (props.items || []).findIndex((entry) => entry.id === itemId)
      const prevId = listIndex > 0 ? props.items[listIndex - 1].id : ''
      const nextId = listIndex >= 0 && listIndex < props.items.length - 1 ? props.items[listIndex + 1].id : ''

      useEffect(() => {
        if (!itemId) return undefined
        const controller = new AbortController()
        let live = true
        setLoading(true)
        setError(null)
        setImageIndex(0)
        setConfirmDelete(false)
        setTagDraft('')
        setNotesDirty(false)
        setNotesSaved(false)
        api('/items/' + encodeURIComponent(itemId), { signal: controller.signal })
          .then((data) => {
            if (!live) return
            const item = data && data.item
            if (!item) throw apiError(tt('library.errorDetail'), 'missing', '', 0)
            setDetail(item)
            setNotesDraft(item.notes || '')
          })
          .catch((reason) => {
            if (!live || (reason && reason.name === 'AbortError')) return
            setError(reason)
          })
          .finally(() => {
            if (live) setLoading(false)
          })
        return () => {
          live = false
          controller.abort()
        }
      }, [itemId, nonce])

      useEffect(() => {
        const node = drawerRef.current
        if (node && typeof node.focus === 'function') {
          try {
            node.focus()
          } catch (reason) {
            /* ignore */
          }
        }
      }, [itemId])

      function flushNotes() {
        const pending = notesApi.current
        if (pending.dirty && pending.detail && pending.save) pending.save(pending.text)
      }
      function closeDrawer() {
        flushNotes()
        props.onClose()
      }
      function navigateTo(id) {
        if (!id) return
        flushNotes()
        props.onNavigate(id)
      }
      useEscape(closeDrawer, !!props.active)

      useEffect(() => {
        if (!props.active) return undefined
        const onKey = (event) => {
          const tag = event.target && event.target.tagName ? String(event.target.tagName).toLowerCase() : ''
          if (tag === 'input' || tag === 'textarea' || tag === 'select') return
          if (event.key === 'ArrowLeft' && prevId) {
            event.preventDefault()
            navigateTo(prevId)
          } else if (event.key === 'ArrowRight' && nextId) {
            event.preventDefault()
            navigateTo(nextId)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [props.active, prevId, nextId])

      useEffect(() => {
        if (!notesDirty || !detail) return undefined
        const timer = setTimeout(() => {
          saveNotes(notesDraft)
        }, 900)
        return () => clearTimeout(timer)
      }, [notesDraft, notesDirty, detail && detail.id])

      function patchItem(patch) {
        if (!detail) return Promise.resolve(null)
        setPatching(true)
        return api('/items/' + encodeURIComponent(detail.id), { method: 'PATCH', body: patch })
          .then((data) => {
            const next = data && data.item
            if (next) {
              setDetail(next)
              if (props.onChanged) props.onChanged(next)
              return next
            }
            return null
          })
          .catch((reason) => {
            props.showToast(errMessage(reason))
            return null
          })
          .finally(() => setPatching(false))
      }
      function saveNotes(value) {
        if (!detail) return
        const queue = notesQueue.current
        if (queue.busy) {
          queue.next = value
          return
        }
        queue.busy = true
        setSavingNotes(true)
        api('/items/' + encodeURIComponent(detail.id), { method: 'PATCH', body: { notes: value } })
          .then((data) => {
            const next = data && data.item
            if (!next) return
            setDetail(next)
            setNotesDirty(false)
            setNotesSaved(true)
            if (props.onChanged) props.onChanged(next)
          })
          .catch((reason) => props.showToast(errMessage(reason)))
          .finally(() => {
            queue.busy = false
            setSavingNotes(false)
            if (queue.next !== null) {
              const queued = queue.next
              queue.next = null
              saveNotes(queued)
            }
          })
      }
      notesApi.current = { dirty: notesDirty, text: notesDraft, detail: detail, save: saveNotes }
      function addTag() {
        if (!detail) return
        const value = String(tagDraft || '').replace(/,$/, '').trim()
        if (!value) return
        const existing = Array.isArray(detail.tags) ? detail.tags : []
        setTagDraft('')
        if (existing.some((tag) => String(tag).toLowerCase() === value.toLowerCase())) return
        patchItem({ tags: existing.concat([value]).slice(0, 24) })
      }
      function removeTag(tag) {
        if (!detail) return
        const existing = Array.isArray(detail.tags) ? detail.tags : []
        patchItem({ tags: existing.filter((entry) => entry !== tag) })
      }
      function revealPath() {
        if (!detail) return
        const image = detail.images && detail.images[imageIndex] ? detail.images[imageIndex] : null
        const absolute = image ? joinPath(props.libraryDir, image.file) : joinPath(props.libraryDir, '')
        copyText(absolute).then((ok) => {
          props.showToast(ok ? tt('library.pathCopied') : tt('errors.copyFailed'), ok ? 'info' : 'error')
        })
        api('/reveal', { method: 'POST', body: { path: absolute } }).catch(() => {
          /* host reveal is best effort; the absolute path is already on the clipboard */
        })
      }
      function doDelete() {
        if (!detail) return
        setDeleting(true)
        api('/items/' + encodeURIComponent(detail.id), { method: 'DELETE' })
          .then(() => {
            props.showToast(tt('library.deleted'))
            if (props.onDeleted) props.onDeleted(detail.id)
          })
          .catch((reason) => props.showToast(errMessage(reason)))
          .finally(() => setDeleting(false))
      }

      const images = detail && Array.isArray(detail.images) ? detail.images : []
      const image = images[imageIndex] || images[0] || null
      const tags = detail && Array.isArray(detail.tags) ? detail.tags : []
      const params = (detail && detail.params) || {}
      const imageUrl = detail && image ? fileUrl(detail.id, Math.min(imageIndex, images.length - 1), !!image.thumb) : ''
      const fullUrl = detail ? fileUrl(detail.id, Math.min(imageIndex, Math.max(0, images.length - 1)), false) : ''

      return h('aside', {
        className: 'isx-drawer',
        ref: drawerRef,
        tabIndex: -1,
        role: 'dialog',
        'aria-label': tt('library.detailTitle')
      },
      h('div', { className: 'isx-drawerHead' },
        h('span', { className: 'isx-drawerTitle' }, tt('library.detailTitle')),
        h('span', { className: 'isx-grow' }),
        h(IconBtn, { icon: I.arrowLeft, label: tt('library.previous'), disabled: !prevId, onClick: () => navigateTo(prevId) }),
        h(IconBtn, { icon: I.arrowRight, label: tt('library.next'), disabled: !nextId, onClick: () => navigateTo(nextId) }),
        h(IconBtn, { icon: I.x, label: tt('common.close'), onClick: closeDrawer })),
      h('div', { className: 'isx-drawerScroll' },
        loading ? h('div', { className: 'isx-popoverStatus' }, h(Spinner, null), tt('library.loadingDetail')) : null,
        error ? h(ErrorCard, {
          title: tt('library.errorDetail'),
          message: errMessage(error),
          onCopy: (text) => copyText(text).then((ok) => props.showToast(ok ? tt('common.copied') : tt('errors.copyFailed'))),
          dismissLabel: tt('common.retry'),
          onDismiss: () => setNonce(nonce + 1)
        }) : null,
        detail && !loading ? h(React.Fragment, null,
          h('div', { className: 'isx-drawerImage', style: image ? imageRatioStyle(image) : { aspectRatio: '1 / 1' } },
            h(Img, { src: imageUrl, fallback: fullUrl, alt: tt('library.imageAlt', { prompt: truncate(detail.prompt, 60) }), className: 'isx-drawerImg', eager: true })),
          images.length > 1 ? h('div', { className: 'isx-thumbs' }, images.map((entry, index) => h('button', {
            key: (entry && entry.file) || index,
            type: 'button',
            className: 'isx-thumbBtn',
            'aria-pressed': index === imageIndex,
            'aria-label': tt('library.thumb', { n: index + 1 }),
            onClick: () => setImageIndex(index)
          }, h(Img, { src: fileUrl(detail.id, index, true), fallback: fileUrl(detail.id, index, false), alt: '' })))) : null,
          h('div', { className: 'isx-drawerBlock' },
            h('div', { className: 'isx-blockHead' },
              h('span', { className: 'isx-blockTitle' }, tt('library.prompt')),
              h(IconBtn, {
                icon: I.copy,
                label: tt('create.copyPrompt'),
                onClick: () => copyText(detail.prompt).then((ok) => props.showToast(ok ? tt('common.copied') : tt('errors.copyFailed')))
              })),
            h('p', { className: 'isx-promptText' }, detail.prompt),
            detail.revisedPrompt ? h('div', { className: 'isx-revised' },
              h('span', { className: 'isx-metaText' }, tt('library.revisedPrompt')),
              h('p', { className: 'isx-promptText' }, detail.revisedPrompt)) : null),
          h('div', { className: 'isx-fields' },
            h(DetailRow, { label: tt('library.provider') }, providerLabel(props.providers, detail.provider)),
            h(DetailRow, { label: tt('library.model') }, modelLabel(props.providers, detail.provider, detail.model)),
            h(DetailRow, { label: tt('library.aspectSize') }, [params.aspect, params.size].filter(Boolean).join(' \u00b7 ') || '\u2014'),
            h(DetailRow, { label: tt('library.quality') }, params.quality ? qualityLabel(params.quality) : '\u2014'),
            h(DetailRow, { label: tt('library.seed') }, params.seed === null || params.seed === undefined ? tt('create.seedRandom') : String(params.seed)),
            h(DetailRow, { label: tt('library.latency') }, formatLatency(detail.latencyMs)),
            h(DetailRow, { label: tt('library.created') }, formatDate(detail.createdAt)),
            h(DetailRow, { label: tt('library.source'), title: sourceText(detail) }, sourceText(detail))),
          h('div', { className: 'isx-drawerBlock' },
            h('span', { className: 'isx-blockTitle' }, tt('library.tags')),
            tags.length ? h('div', { className: 'isx-tagEditor' }, tags.map((tag) => h('span', { key: tag, className: 'isx-tagChip' },
              h('span', null, tag),
              h(IconBtn, { icon: I.x, label: tt('library.removeTag', { tag: tag }), onClick: () => removeTag(tag) })))) : null,
            h('input', {
              className: 'isx-input',
              type: 'text',
              value: tagDraft,
              placeholder: tt('library.tagPlaceholder'),
              'aria-label': tt('library.tags'),
              onChange: (event) => setTagDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ',') {
                  event.preventDefault()
                  addTag()
                }
              },
              onBlur: addTag
            })),
          h('div', { className: 'isx-drawerBlock' },
            h('div', { className: 'isx-blockHead' },
              h('span', { className: 'isx-blockTitle' }, tt('library.rating')),
              patching ? h(Spinner, null) : null),
            h(Stars, {
              value: detail.rating || 0,
              label: tt('library.rating'),
              disabled: patching,
              onRate: (next) => patchItem({ rating: next })
            })),
          h('div', { className: 'isx-drawerBlock' },
            h('div', { className: 'isx-blockHead' },
              h('label', { className: 'isx-blockTitle', htmlFor: 'isx-notes' }, tt('library.notes')),
              h('span', { className: 'isx-grow' }),
              notesSaved && !notesDirty ? h('span', { className: 'isx-count' }, tt('common.saved')) : null),
            h('textarea', {
              id: 'isx-notes',
              className: 'isx-textarea isx-notes',
              rows: 4,
              value: notesDraft,
              placeholder: tt('library.notesPlaceholder'),
              'aria-label': tt('library.notes'),
              onChange: (event) => {
                setNotesDraft(event.target.value)
                setNotesDirty(true)
                setNotesSaved(false)
              }
            }),
            h('div', { className: 'isx-inline isx-end' },
              h(Btn, { size: 'sm', busy: savingNotes, disabled: !notesDirty || savingNotes, onClick: () => saveNotes(notesDraft) }, tt('library.saveNotes')))),
          h('div', { className: 'isx-drawerActions' },
            h(Btn, {
              icon: I.star,
              iconProps: { filled: !!detail.favorite },
              'aria-pressed': !!detail.favorite,
              onClick: () => patchItem({ favorite: !detail.favorite })
            }, detail.favorite ? tt('create.unfavorite') : tt('create.favorite')),
            h(Btn, { icon: I.image, onClick: () => props.onUseReference(detail.id) }, tt('create.useAsRef')),
            h('a', { className: 'isx-btn', 'data-variant': 'secondary', href: downloadUrl(detail.id, imageIndex), download: '' },
              h(I.download, { size: 14 }), h('span', { className: 'isx-btnLabel' }, tt('create.download'))),
            h(Btn, { icon: I.folder, onClick: revealPath }, tt('library.revealPath')),
            confirmDelete
              ? h(Btn, { variant: 'danger', busy: deleting, disabled: deleting, onClick: doDelete }, tt('library.deleteConfirm'))
              : h(Btn, { variant: 'danger', onClick: () => setConfirmDelete(true) }, tt('library.delete')),
            confirmDelete ? h(Btn, { disabled: deleting, onClick: () => setConfirmDelete(false) }, tt('common.cancel')) : null,
            confirmDelete ? h('p', { className: 'isx-hint isx-full' }, tt('library.deleteBody')) : null)) : null))
    }
    function LibraryTab(props) {
      const providers = props.providers || []
      const [query, setQuery] = useState('')
      const debouncedQuery = useDebounced(query, 200)
      const [providerFilter, setProviderFilter] = useState('')
      const [favorites, setFavorites] = useState(false)
      const [sort, setSort] = useState('newest')
      const [items, setItems] = useState([])
      const [total, setTotal] = useState(0)
      const [hasMore, setHasMore] = useState(false)
      const [nextCursor, setNextCursor] = useState('')
      const [loading, setLoading] = useState(true)
      const [loadingMore, setLoadingMore] = useState(false)
      const [error, setError] = useState(null)
      const [selectedId, setSelectedId] = useState('')
      const [retryNonce, setRetryNonce] = useState(0)
      const seqRef = useRef(0)
      const filtersActive = !!(query.trim() || providerFilter || favorites)

      useEffect(() => {
        if (!props.active) return undefined
        const controller = new AbortController()
        const seq = ++seqRef.current
        setLoading(true)
        setError(null)
        api('/items', {
          query: { q: debouncedQuery, provider: providerFilter, favorite: favorites ? '1' : '', sort: sort, limit: PAGE_SIZE },
          signal: controller.signal
        })
          .then((data) => {
            if (seq !== seqRef.current) return
            setItems(data && Array.isArray(data.items) ? data.items : [])
            setTotal(data && data.total !== undefined ? data.total : 0)
            setHasMore(!!(data && data.hasMore))
            setNextCursor((data && data.nextCursor) || '')
          })
          .catch((reason) => {
            if (seq !== seqRef.current || (reason && reason.name === 'AbortError')) return
            setError(reason)
          })
          .finally(() => {
            if (seq === seqRef.current) setLoading(false)
          })
        return () => controller.abort()
      }, [debouncedQuery, providerFilter, favorites, sort, props.active, props.refreshTick, retryNonce])

      useEffect(() => {
        if (props.focus && props.focus.id) setSelectedId(props.focus.id)
      }, [props.focus])

      function loadMore() {
        if (loadingMore || !hasMore || !nextCursor) return
        const seq = seqRef.current
        setLoadingMore(true)
        api('/items', {
          query: { q: debouncedQuery, provider: providerFilter, favorite: favorites ? '1' : '', sort: sort, limit: PAGE_SIZE, cursor: nextCursor }
        })
          .then((data) => {
            if (seq !== seqRef.current) return
            const known = {}
            setItems((current) => {
              current.forEach((entry) => {
                known[entry.id] = true
              })
              const extra = (data && Array.isArray(data.items) ? data.items : []).filter((entry) => {
                if (known[entry.id]) return false
                known[entry.id] = true
                return true
              })
              return current.concat(extra)
            })
            setTotal(data && data.total !== undefined ? data.total : total)
            setHasMore(!!(data && data.hasMore))
            setNextCursor((data && data.nextCursor) || '')
          })
          .catch((reason) => props.showToast(errMessage(reason)))
          .finally(() => setLoadingMore(false))
      }
      function toggleFavorite(item) {
        api('/items/' + encodeURIComponent(item.id), { method: 'PATCH', body: { favorite: !item.favorite } })
          .then((data) => {
            const next = data && data.item
            if (!next) return
            setItems((current) => current.map((entry) => (entry.id === next.id ? next : entry)))
          })
          .catch((reason) => props.showToast(errMessage(reason)))
      }
      function applyChanged(next) {
        setItems((current) => current.map((entry) => (entry.id === next.id ? next : entry)))
      }
      function applyDeleted(id) {
        setItems((current) => current.filter((entry) => entry.id !== id))
        setTotal((current) => Math.max(0, current - 1))
        setSelectedId('')
        if (props.reloadBootstrap) props.reloadBootstrap()
      }
      function clearFilters() {
        setQuery('')
        setProviderFilter('')
        setFavorites(false)
        setSort('newest')
      }

      const providerOptions = [{ value: '', label: tt('library.allProviders') }].concat(providers.map((entry) => ({ value: entry.id, label: entry.label || entry.id })))
      const showEmpty = !loading && !error && !items.length

      return h('div', { className: 'isx-lib' },
        h('div', { className: 'isx-libMain' },
          h('div', { className: 'isx-libFilters' },
            h('div', { className: 'isx-searchWrap' },
              h(I.search, { size: 14 }),
              h('input', {
                className: 'isx-input isx-search',
                type: 'search',
                value: query,
                placeholder: tt('library.search'),
                'aria-label': tt('library.search'),
                onChange: (event) => setQuery(event.target.value)
              })),
            h(Select, { value: providerFilter, onChange: setProviderFilter, ariaLabel: tt('library.provider'), options: providerOptions }),
            h('button', {
              type: 'button',
              className: 'isx-toggle',
              'aria-pressed': favorites,
              onClick: () => setFavorites((value) => !value)
            }, h(I.star, { size: 13, filled: favorites }), tt('library.favorites')),
            h(Select, {
              value: sort,
              onChange: setSort,
              ariaLabel: tt('library.sort'),
              options: [{ value: 'newest', label: tt('library.newest') }, { value: 'oldest', label: tt('library.oldest') }]
            }),
            h('span', { className: 'isx-grow' }),
            h('span', { className: 'isx-count' }, loading ? tt('library.count', { total: '\u2014' }) : itemCountLabel(total))),
          h('div', { className: 'isx-libScroll', 'aria-busy': loading ? 'true' : 'false' },
            loading && !items.length ? h('div', { className: 'isx-libGrid' },
              [0, 1, 2, 3, 4, 5, 6, 7].map((n) => h('div', { key: n, className: 'isx-skelCard' },
                h('div', { className: 'isx-skelThumb' }),
                h('div', { className: 'isx-skelLine' }),
                h('div', { className: 'isx-skelLine isx-skelShort' })))) : null,
            error ? h(ErrorCard, {
              title: tt('library.errorTitle'),
              message: errMessage(error),
              dismissLabel: tt('common.retry'),
              onCopy: (text) => copyText(text).then((ok) => props.showToast(ok ? tt('common.copied') : tt('errors.copyFailed'))),
              onDismiss: () => setRetryNonce(retryNonce + 1)
            }) : null,
            showEmpty ? h('div', { className: 'isx-emptyWrap' }, h(EmptyState, {
              glyph: h(I.studio, { size: 28 }),
              title: filtersActive ? tt('library.emptyFilteredTitle') : tt('library.emptyTitle'),
              body: filtersActive ? tt('library.emptyFilteredBody') : tt('library.emptyBody')
            },
            h(Btn, { variant: 'primary', onClick: props.onOpenCreate }, tt('library.openCreate')),
            filtersActive ? h(Btn, { onClick: clearFilters }, tt('library.clearFilters')) : null)) : null,
            items.length ? h('div', { className: 'isx-libGrid' }, items.map((item) => h(LibraryCard, {
              key: item.id,
              item: item,
              providers: providers,
              selected: selectedId === item.id,
              onOpen: () => setSelectedId(item.id),
              onToggleFavorite: toggleFavorite
            }))) : null,
            items.length && hasMore ? h('div', { className: 'isx-loadMore' },
              h(Btn, { busy: loadingMore, disabled: loadingMore, onClick: loadMore }, tt('library.loadMore'))) : null,
            items.length && !hasMore && !loading ? h('div', { className: 'isx-count isx-center' }, itemCountLabel(total)) : null)),
        selectedId ? h(DetailDrawer, {
          itemId: selectedId,
          items: items,
          providers: providers,
          libraryDir: props.libraryDir,
          active: !!props.active,
          showToast: props.showToast,
          onClose: () => setSelectedId(''),
          onNavigate: (id) => setSelectedId(id),
          onChanged: applyChanged,
          onDeleted: applyDeleted,
          onUseReference: props.onUseReference,
          reloadBootstrap: props.reloadBootstrap
        }) : null)
    }
    //#endregion

    //#region Compare tab
    function CompareColumn(props) {
      const result = props.result
      const item = props.item || null
      const image = item && item.images && item.images[0] ? item.images[0] : null
      const ok = result.status === 'succeeded'
      return h('div', { className: 'isx-col' },
        h('div', { className: 'isx-colHead' },
          h('span', { className: 'isx-colTitle', title: providerLabel(props.providers, result.provider) + ' \u00b7 ' + modelLabel(props.providers, result.provider, result.model) },
            providerLabel(props.providers, result.provider) + ' \u00b7 ' + modelLabel(props.providers, result.provider, result.model)),
          h('div', { className: 'isx-colMeta' },
            h(Pill, { tone: ok ? 'ok' : 'bad' }, ok ? tt('compare.columnSucceeded') : tt('compare.columnFailed')),
            h('span', { className: 'isx-count' }, formatLatency(result.latencyMs)))),
        h('div', { className: 'isx-colBody' },
          ok && result.itemId
            ? h('div', { className: 'isx-plate', style: image ? imageRatioStyle(image) : { aspectRatio: '1 / 1' } },
              h(Img, {
                src: fileUrl(result.itemId, 0, true),
                fallback: fileUrl(result.itemId, 0, false),
                alt: item ? tt('library.imageAlt', { prompt: truncate(item.prompt, 70) }) : tt('compare.openInLibrary'),
                className: 'isx-plateImg'
              }))
            : ok
              ? h('div', { className: 'isx-colEmpty' }, tt('compare.noImage'))
              : h('div', { className: 'isx-colError', role: 'alert' },
                h(I.alert, { size: 16 }),
                h('p', null, result.error || tt('errors.unknown')))),
        h('div', { className: 'isx-colFoot' },
          item ? h(Stars, { value: item.rating || 0, size: 15, label: tt('compare.rating'), onRate: (n) => props.onRate(item, n) }) : null,
          h('span', { className: 'isx-grow' }),
          result.itemId ? h(Btn, { size: 'sm', onClick: () => props.onOpenLibrary(result.itemId) }, tt('compare.openInLibrary')) : null,
          h(Btn, { size: 'sm', icon: I.spark, onClick: props.onUsePrompt }, tt('compare.usePrompt'))))
    }
    function CompareTab(props) {
      const providers = props.providers || []
      const defaults = props.defaults || {}
      const settings = props.settings || {}
      const [prompt, setPrompt] = useState('')
      const [negative, setNegative] = useState('')
      const [showNegative, setShowNegative] = useState(false)
      const [targets, setTargets] = useState([])
      const [running, setRunning] = useState(false)
      const [run, setRun] = useState(null)
      const [error, setError] = useState(null)
      const [runs, setRuns] = useState([])
      const [runsLoading, setRunsLoading] = useState(true)
      const [runsError, setRunsError] = useState(null)
      const [itemMap, setItemMap] = useState({})
      const [runsNonce, setRunsNonce] = useState(0)
      const initialized = useRef(false)
      const abortRef = useRef(null)
      const scrollRef = useRef(null)
      const promptRef = useRef(null)
      const pairs = useMemo(() => targetPairs(providers), [providers])

      useEffect(() => {
        if (initialized.current) return
        initialized.current = true
        const saved = normalizeTargets(props.compareTargets || [], providers)
        if (saved.length) setTargets(saved)
      }, [providers, props.compareTargets])

      const loadRuns = useCallback((signal) => {
        setRunsLoading(true)
        setRunsError(null)
        return api('/runs', { query: { limit: 10 }, signal: signal })
          .then((data) => setRuns(data && Array.isArray(data.runs) ? data.runs : []))
          .catch((reason) => {
            if (reason && reason.name === 'AbortError') return
            setRunsError(reason)
          })
          .finally(() => setRunsLoading(false))
      }, [])

      useEffect(() => {
        const controller = new AbortController()
        loadRuns(controller.signal)
        return () => controller.abort()
      }, [loadRuns, props.refreshTick, runsNonce])

      const runId = run ? run.id : ''
      useEffect(() => {
        if (!run) {
          setItemMap({})
          return undefined
        }
        const ids = (run.results || []).filter((entry) => entry.status === 'succeeded' && entry.itemId).map((entry) => entry.itemId)
        if (!ids.length) {
          setItemMap({})
          return undefined
        }
        let live = true
        Promise.all(ids.map((id) => api('/items/' + encodeURIComponent(id)).then((data) => data && data.item).catch(() => null)))
          .then((loaded) => {
            if (!live) return
            const map = {}
            loaded.forEach((item, index) => {
              if (item) map[ids[index]] = item
            })
            setItemMap(map)
          })
        return () => {
          live = false
        }
      }, [runId, props.refreshTick])

      useEffect(() => {
        return () => {
          if (abortRef.current) abortRef.current.abort()
        }
      }, [])

      function persistTargets(next) {
        if (!props.patchSettings) return
        const ui = Object.assign({}, settings.ui || {}, { compareTargets: next })
        props.patchSettings({ ui: ui }).catch((reason) => props.showToast(errMessage(reason)))
      }
      function toggleTarget(pair) {
        const exists = targets.some((entry) => entry.provider === pair.provider && entry.model === pair.model)
        if (exists) {
          const next = targets.filter((entry) => !(entry.provider === pair.provider && entry.model === pair.model))
          setTargets(next)
          persistTargets(next)
          return
        }
        if (targets.length >= MAX_COMPARE) {
          props.showToast(tt('compare.maxTargets', { count: MAX_COMPARE }))
          return
        }
        const next = targets.concat([{ provider: pair.provider, model: pair.model }])
        setTargets(next)
        persistTargets(next)
      }
      function loadRun(next) {
        setRun(next)
        setError(null)
        if (scrollRef.current) scrollRef.current.scrollTop = 0
      }
      function rate(item, value) {
        const next = (item.rating || 0) === value ? 0 : value
        api('/items/' + encodeURIComponent(item.id), { method: 'PATCH', body: { rating: next } })
          .then((data) => {
            if (data && data.item) setItemMap((current) => Object.assign({}, current, { [data.item.id]: data.item }))
          })
          .catch((reason) => props.showToast(errMessage(reason)))
      }
      const canRun = targets.length >= 2 && String(prompt || '').trim().length > 0 && !running
      function runComparison() {
        if (!canRun) return
        const controller = new AbortController()
        abortRef.current = controller
        setRunning(true)
        setError(null)
        api('/compare', {
          method: 'POST',
          signal: controller.signal,
          body: {
            targets: targets,
            prompt: String(prompt || '').trim(),
            negativePrompt: String(negative || '').trim(),
            aspect: defaults.aspect || '',
            size: '',
            quality: defaults.quality || '',
            count: 1,
            seed: null
          }
        })
          .then((data) => {
            if (!data || !data.run) throw apiError(tt('errors.unknown'), 'empty', '', 0)
            setRun(data.run)
            if (scrollRef.current) scrollRef.current.scrollTop = 0
            loadRuns()
          })
          .catch((reason) => {
            if (reason && reason.name === 'AbortError') {
              props.showToast(tt('create.cancelled'))
              return
            }
            setError(reason)
          })
          .finally(() => {
            abortRef.current = null
            setRunning(false)
          })
      }
      useShortcut(!!props.active, () => {
        if (running) return
        runComparison()
      })

      const results = run && Array.isArray(run.results) ? run.results : []
      const columns = Math.max(1, results.length)
      return h('div', { className: 'isx-scroll', ref: scrollRef },
        h('section', { className: 'isx-card isx-compareCard' },
          h(PromptEditor, {
            value: prompt,
            onChange: setPrompt,
            showNegative: showNegative,
            negative: negative,
            onNegativeChange: setNegative,
            onToggleNegative: () => setShowNegative((value) => !value),
            textareaRef: promptRef,
            minHeight: 96,
            maxHeight: 260
          }),
          h('div', { className: 'isx-field' },
            h('div', { className: 'isx-fieldLabelRow' },
              h('span', { className: 'isx-fieldLabel' }, tt('compare.targetsTitle')),
              h('span', { className: 'isx-count' }, tt('compare.selectedCount', { count: targets.length, max: MAX_COMPARE }))),
            h('p', { className: 'isx-hint' }, tt('compare.targetsHint')),
            providers.length
              ? h('div', { className: 'isx-targetGroups' }, providers.map((provider) => {
                const models = modelList(provider)
                if (!models.length) return null
                return h('div', { key: provider.id, className: 'isx-targetGroup' },
                  h('span', { className: 'isx-targetGroupName' }, provider.label || provider.id),
                  h('div', { className: 'isx-targetChips' }, models.map((model) => {
                    const checked = targets.some((entry) => entry.provider === provider.id && entry.model === model.id)
                    return h('label', { key: model.id, className: 'isx-targetChip', 'data-checked': checked ? 'true' : undefined },
                      h('input', { type: 'checkbox', checked: checked, onChange: () => toggleTarget({ provider: provider.id, model: model.id }) }),
                      h('span', null, model.label || model.id))
                  })))
              }))
              : h('p', { className: 'isx-hint' }, tt('settings.emptyProviders'))),
          h('div', { className: 'isx-promptActions' },
            h('span', { className: 'isx-metaText' }, tt('compare.params', {
              aspect: defaults.aspect || '\u2014',
              quality: defaults.quality ? qualityLabel(defaults.quality) : tt('settings.qualityAuto'),
              count: 1
            })),
            h('span', { className: 'isx-grow' }),
            targets.length < 2
              ? h('span', { className: 'isx-hint' }, tt('compare.needTwo'))
              : !String(prompt || '').trim()
                ? h('span', { className: 'isx-hint' }, tt('compare.needPrompt'))
                : null,
            running ? h(Btn, { size: 'sm', onClick: () => { if (abortRef.current) abortRef.current.abort() } }, tt('compare.cancel')) : null,
            h(Btn, {
              variant: 'primary',
              disabled: !canRun,
              busy: running,
              title: tt('compare.run') + ' (' + SHORTCUT_HINT + ')',
              onClick: runComparison
            }, running ? tt('compare.running') : tt('compare.run'), !running ? h('kbd', { className: 'isx-kbd', 'aria-hidden': 'true' }, SHORTCUT_HINT) : null)),
          error ? h(ErrorCard, {
            title: tt('compare.errorTitle'),
            message: errMessage(error),
            hint: error && error.hint ? error.hint : '',
            onCopy: (text) => copyText(text).then((ok) => props.showToast(ok ? tt('common.copied') : tt('errors.copyFailed'))),
            onDismiss: () => setError(null)
          }) : null),
        results.length
          ? h('div', { className: 'isx-cols', style: { gridTemplateColumns: 'repeat(' + columns + ', minmax(240px, 1fr))' } },
            results.map((result) => h(CompareColumn, {
              key: result.provider + '\u0000' + result.model,
              result: result,
              item: itemMap[result.itemId] || null,
              providers: providers,
              onRate: rate,
              onOpenLibrary: props.onOpenLibrary,
              onUsePrompt: () => props.onUsePrompt(run && run.prompt ? run.prompt : prompt)
            }))) : h('div', { className: 'isx-emptyWrap' },
            h(EmptyState, { glyph: h(I.image, { size: 26 }), title: tt('compare.emptyTitle'), body: tt('compare.emptyBody') },
              h(Btn, { variant: 'primary', onClick: () => { if (promptRef.current) promptRef.current.focus() } }, tt('compare.focusPrompt')))),
        h('section', { className: 'isx-section' },
          h('div', { className: 'isx-sectionHead' },
            h('h2', { className: 'isx-sectionTitle' }, tt('compare.savedRuns')),
            h('span', { className: 'isx-grow' }),
            h('span', { className: 'isx-count' }, runs.length ? formatNumber(runs.length) : '')),
          runsLoading ? h('div', { className: 'isx-popoverStatus' }, h(Spinner, null), tt('compare.loadingRuns')) : null,
          runsError ? h('div', { className: 'isx-popoverStatus isx-popoverError' },
            h('span', null, tt('compare.runsError')),
            h(Btn, { onClick: () => setRunsNonce(runsNonce + 1) }, tt('common.retry'))) : null,
          !runsLoading && !runsError && !runs.length ? h('div', { className: 'isx-popoverStatus' },
            tt('compare.noRuns') + ' ' + tt('compare.noRunsBody')) : null,
          runs.length ? h('div', { className: 'isx-runs' }, runs.map((entry) => {
            const thumbs = (entry.results || []).filter((res) => res.status === 'succeeded' && res.itemId).slice(0, 4)
            const names = (entry.targets || []).map((target) => modelLabel(providers, target.provider, target.model)).filter(Boolean)
            return h('button', {
              key: entry.id,
              type: 'button',
              className: 'isx-runRow',
              'data-active': run && run.id === entry.id ? 'true' : undefined,
              'aria-current': run && run.id === entry.id ? 'true' : undefined,
              onClick: () => loadRun(entry)
            },
            h('span', { className: 'isx-runText' },
              h('span', { className: 'isx-runPrompt' }, entry.prompt || tt('library.untitled')),
              h('span', { className: 'isx-runMeta' }, [formatDate(entry.createdAt), names.join(' / ')].filter(Boolean).join(' \u00b7 '))),
            h('span', { className: 'isx-runThumbs' }, thumbs.map((res) => h('span', { key: res.itemId, className: 'isx-runThumb' },
              h(Img, { src: fileUrl(res.itemId, 0, true), fallback: fileUrl(res.itemId, 0, false), alt: '' })))))
          })) : null))
    }
    //#endregion

    //#region Settings tab
    function ProviderCard(props) {
      const provider = props.provider
      const settings = props.settings || {}
      const persisted = (settings.providers && settings.providers[provider.id]) || {}
      const [keyDraft, setKeyDraft] = useState('')
      const [savingKey, setSavingKey] = useState(false)
      const [clearingKey, setClearingKey] = useState(false)
      const [testing, setTesting] = useState(false)
      const [testResult, setTestResult] = useState(null)
      const [baseDraft, setBaseDraft] = useState(null)
      const [savingBase, setSavingBase] = useState(false)
      const [modelDraft, setModelDraft] = useState(null)
      const [savingModel, setSavingModel] = useState(false)
      const uid = useUid('provider')
      const status = statusOfProvider(provider)
      const models = modelList(provider)
      const currentModel = modelDraft !== null
        ? modelDraft
        : persisted.defaultModel || provider.defaultModel || (models[0] ? models[0].id : '')
      const currentBase = baseDraft !== null
        ? baseDraft
        : Object.prototype.hasOwnProperty.call(persisted, 'baseUrl')
          ? persisted.baseUrl || ''
          : provider.baseUrl || ''
      const modelOptions = [{ value: '', label: tt('settings.modelAuto') }].concat(models.map((model) => ({ value: model.id, label: model.label || model.id })))
      if (currentModel && !modelOptions.some((option) => option.value === currentModel)) modelOptions.push({ value: currentModel, label: currentModel })
      const ambient = provider.ambient || {}
      const statusText = provider.ambientAuth
        ? provider.configured
          ? tt('settings.status.ambient', { source: ambient.source || 'ADC' })
          : tt('settings.status.notConfigured')
        : status === 'connected'
        ? tt('settings.status.connected')
        : status === 'fromEnv'
          ? tt('settings.status.fromEnv', { name: provider.source })
          : status === 'notConfigured'
            ? tt('settings.status.notConfigured')
            : tt('settings.status.noKey')

      function saveKey() {
        const value = String(keyDraft || '').trim()
        if (!value || savingKey) return
        setSavingKey(true)
        api('/credentials', { method: 'POST', body: { provider: provider.id, apiKey: value } })
          .then((data) => {
            if (data && Array.isArray(data.providers) && props.onProviders) props.onProviders(data.providers)
            setKeyDraft('')
            props.showToast(tt('settings.keySaved', { provider: provider.label || provider.id }))
            if (props.reloadBootstrap) props.reloadBootstrap()
          })
          .catch((reason) => props.showToast(errMessage(reason)))
          .finally(() => setSavingKey(false))
      }
      function clearKey() {
        if (clearingKey) return
        setClearingKey(true)
        api('/credentials/' + encodeURIComponent(provider.id), { method: 'DELETE' })
          .then((data) => {
            if (data && Array.isArray(data.providers) && props.onProviders) props.onProviders(data.providers)
            setTestResult(null)
            props.showToast(tt('settings.keyCleared', { provider: provider.label || provider.id }))
            if (props.reloadBootstrap) props.reloadBootstrap()
          })
          .catch((reason) => props.showToast(errMessage(reason)))
          .finally(() => setClearingKey(false))
      }
      function testConnection() {
        if (testing) return
        setTesting(true)
        setTestResult(null)
        api('/credentials/test', { method: 'POST', body: { provider: provider.id, model: currentModel || undefined } })
          .then((data) => {
            if (data && data.ok) setTestResult({ ok: true, text: tt('settings.testOk', { ms: Math.round(Number(data.latencyMs) || 0) }) })
            else setTestResult({ ok: false, text: (data && data.message) || tt('settings.testFailed') })
          })
          .catch((reason) => setTestResult({ ok: false, text: errMessage(reason) }))
          .finally(() => setTesting(false))
      }
      function saveModel(nextValue) {
        setModelDraft(nextValue)
        const map = Object.assign({}, settings.providers || {})
        map[provider.id] = Object.assign({}, map[provider.id] || {}, { defaultModel: nextValue })
        setSavingModel(true)
        props.patchSettings({ providers: map })
          .then(() => props.showToast(tt('settings.modelUpdated')))
          .catch((reason) => {
            setModelDraft(null)
            props.showToast(errMessage(reason))
          })
          .finally(() => setSavingModel(false))
      }
      function saveBase() {
        const nextValue = String(currentBase || '').trim()
        const map = Object.assign({}, settings.providers || {})
        map[provider.id] = Object.assign({}, map[provider.id] || {}, { baseUrl: nextValue })
        setSavingBase(true)
        props.patchSettings({ providers: map })
          .then(() => {
            setBaseDraft(null)
            props.showToast(tt('settings.endpointSaved'))
            if (props.reloadBootstrap) props.reloadBootstrap()
          })
          .catch((reason) => props.showToast(errMessage(reason)))
          .finally(() => setSavingBase(false))
      }

      return h('section', { className: 'isx-providerCard' },
        h('div', { className: 'isx-providerHead' },
          h('span', { className: 'isx-providerIcon', 'aria-hidden': 'true' }, providerInitials(provider.label || provider.id)),
          h('div', { className: 'isx-providerName' },
            h('span', { className: 'isx-providerTitle' }, provider.label || provider.id)),
          h('span', { className: 'isx-grow' }),
          h(Pill, { tone: provider.ambientAuth ? (provider.configured ? 'ok' : 'idle') : status === 'connected' ? 'ok' : status === 'fromEnv' ? 'warn' : 'idle' }, statusText)),
        h('div', { className: 'isx-providerBody' },
          provider.ambientAuth ? h('div', { className: 'isx-ambient' },
            h('div', { className: 'isx-ambientLine' },
              h(provider.configured ? I.check : I.info, { size: 13 }),
              h('span', null, provider.configured
                ? tt('settings.ambientReady', { source: ambient.source || 'ADC' })
                : tt('settings.ambientMissing'))),
            h('div', { className: 'isx-ambientMeta' },
              h('span', null, tt('settings.ambientProject', { project: ambient.project || tt('common.auto') })),
              h('span', { className: 'isx-metaDot', 'aria-hidden': 'true' }, '\u00b7'),
              h('span', null, tt('settings.ambientLocation', { location: ambient.location || 'us-central1' }))),
            h('p', { className: 'isx-hint' }, provider.configured
              ? tt('settings.ambientHint')
              : ambient.error ? tt('settings.ambientError', { code: ambient.error }) : tt('settings.ambientHint'))) : null,
          h(Field, { label: provider.ambientAuth ? tt('settings.vertexKeyLabel') : tt('settings.keyLabel'), id: uid + '-key', hint: provider.ambientAuth ? tt('settings.vertexKeyHint') : undefined },
            h('div', { className: 'isx-inline' },
              h('input', {
                id: uid + '-key',
                className: 'isx-input',
                type: 'password',
                autoComplete: 'off',
                value: keyDraft,
                placeholder: provider.keyHint || tt('settings.keyPlaceholder'),
                onChange: (event) => setKeyDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    saveKey()
                  }
                }
              }),
              h(Btn, { busy: savingKey, disabled: !keyDraft.trim() || savingKey, onClick: saveKey }, savingKey ? tt('settings.saving') : tt('settings.save')),
              provider.configured ? h(Btn, { busy: clearingKey, disabled: clearingKey, onClick: clearKey }, clearingKey ? tt('settings.clearing') : tt('settings.clear')) : null)),
          h('div', { className: 'isx-row' },
            h(Field, { label: tt('settings.defaultModel'), id: uid + '-model', className: 'isx-rowControl' },
              h(Select, {
                id: uid + '-model',
                value: currentModel,
                disabled: savingModel || !modelOptions.length,
                onChange: saveModel,
                options: modelOptions.length ? modelOptions : [{ value: '', label: tt('create.noModels') }]
              })),
            h(Btn, { disabled: testing, busy: testing, onClick: testConnection }, testing ? tt('settings.testing') : tt('settings.test')),
            testResult ? h('span', { className: testResult.ok ? 'isx-testOk' : 'isx-testBad', role: 'status' }, testResult.text) : null),
          provider.configurableBaseUrl ? h(Field, { label: tt('settings.endpoint'), id: uid + '-base' },
            h('div', { className: 'isx-inline' },
              h('input', {
                id: uid + '-base',
                className: 'isx-input isx-mono',
                type: 'text',
                value: currentBase,
                placeholder: provider.baseUrl || provider.defaultBaseUrl || tt('settings.endpointPlaceholder'),
                onChange: (event) => setBaseDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    saveBase()
                  }
                }
              }),
              h(Btn, { busy: savingBase, disabled: savingBase, onClick: saveBase }, tt('settings.saveEndpoint')))) : null,
          h('div', { className: 'isx-badgeRow' },
            provider.docsUrl ? h('a', { className: 'isx-link', href: provider.docsUrl, target: '_blank', rel: 'noreferrer noopener' }, tt('settings.docs'), h(I.external, { size: 12 })) : null,
            provider.keyUrl ? h('a', { className: 'isx-link', href: provider.keyUrl, target: '_blank', rel: 'noreferrer noopener' }, tt('settings.getKey'), h(I.external, { size: 12 })) : null,
            provider.kind ? h('span', { className: 'isx-count' }, kindLabel(provider.kind)) : null)))
    }
    function SettingsTab(props) {
      const bootstrap = props.bootstrap || {}
      const providers = props.providers || []
      const settings = props.settings || {}
      const defaults = props.defaults || {}
      const library = bootstrap.library || {}
      const [revealing, setRevealing] = useState(false)
      const [refreshing, setRefreshing] = useState(false)
      const [defaultsBusy, setDefaultsBusy] = useState(false)
      const libraryAspects = aspectList(providers)
      const libraryQualities = qualityList(providers)
      const defaultProvider = findProvider(providers, defaults.provider) || providers[0] || null
      const defaultProviderId = defaultProvider ? defaultProvider.id : ''
      const defaultModels = modelList(defaultProvider)
      const modelOptions = [{ value: '', label: tt('settings.modelAuto') }].concat(defaultModels.map((model) => ({ value: model.id, label: model.label || model.id })))
      if (defaults.model && !modelOptions.some((option) => option.value === defaults.model)) modelOptions.push({ value: defaults.model, label: defaults.model })
      const aspectOptions = [{ value: '', label: tt('common.auto') }].concat(libraryAspects.map((entry) => ({ value: entry, label: entry })))
      const qualityOptions = [{ value: '', label: tt('settings.qualityAuto') }].concat(libraryQualities.map((entry) => ({ value: entry, label: qualityLabel(entry) })))
      if (defaults.aspect && !aspectOptions.some((option) => option.value === defaults.aspect)) {
        aspectOptions.push({ value: defaults.aspect, label: defaults.aspect })
      }
      if (defaults.quality && !qualityOptions.some((option) => option.value === defaults.quality)) {
        qualityOptions.push({ value: defaults.quality, label: qualityLabel(defaults.quality) })
      }
      const countOptions = [1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))

      function saveDefaults(patch) {
        const next = Object.assign({}, defaults, patch)
        setDefaultsBusy(true)
        props.patchSettings({ defaults: next })
          .then(() => props.showToast(tt('settings.defaultsSaved')))
          .catch((reason) => props.showToast(errMessage(reason)))
          .finally(() => setDefaultsBusy(false))
      }
      function onDefaultProvider(nextId) {
        const provider = findProvider(providers, nextId)
        saveDefaults({ provider: nextId, model: defaultModelOf(provider) || '' })
      }
      function revealLibrary() {
        setRevealing(true)
        api('/reveal', { method: 'POST', body: { path: library.dir || '' } })
          .then((data) => {
            const opened = !(data && data.ok === false)
            props.showToast(opened ? tt('shell.openedFolder') : tt('settings.revealFailed'), opened ? 'info' : 'error')
          })
          .catch(() => props.showToast(tt('settings.revealFailed'), 'error'))
          .finally(() => setRevealing(false))
      }
      function refreshLibrary() {
        setRefreshing(true)
        Promise.resolve(props.reloadBootstrap ? props.reloadBootstrap() : false)
          .then((ok) => props.showToast(ok === false ? tt('settings.refreshFailed') : tt('settings.refreshed')))
          .catch(() => props.showToast(tt('settings.refreshFailed')))
          .finally(() => setRefreshing(false))
      }

      return h('div', { className: 'isx-scroll' },
        h('section', { className: 'isx-section' },
          h('div', { className: 'isx-sectionHead' },
            h('h2', { className: 'isx-sectionTitle' }, tt('settings.providersTitle')),
            h('p', { className: 'isx-sectionHint' }, tt('settings.providersHint'))),
          providers.length
            ? h('div', { className: 'isx-providerList' }, providers.map((provider) => h(ProviderCard, {
              key: provider.id,
              provider: provider,
              settings: settings,
              patchSettings: props.patchSettings,
              onProviders: props.onProviders,
              reloadBootstrap: props.reloadBootstrap,
              showToast: props.showToast
            })))
            : h(EmptyState, {
              glyph: h(I.studio, { size: 26 }),
              title: tt('settings.emptyProviders'),
              body: tt('settings.emptyProvidersBody')
            }, h(Btn, { icon: I.refresh, onClick: refreshLibrary }, tt('common.retry')))),
        h('section', { className: 'isx-section' },
          h('div', { className: 'isx-sectionHead' },
            h('h2', { className: 'isx-sectionTitle' }, tt('settings.libraryTitle')),
            h('span', { className: 'isx-grow' }),
            h(Btn, { icon: I.folder, disabled: !library.dir || revealing, busy: revealing, onClick: revealLibrary }, IS_MAC ? tt('settings.reveal') : tt('settings.openFolder')),
            h(Btn, { icon: I.refresh, busy: refreshing, disabled: refreshing, onClick: refreshLibrary }, tt('settings.refresh'))),
          h('div', { className: 'isx-card isx-libraryCard' },
            h('div', { className: 'isx-pathRow' },
              h('span', { className: 'isx-fieldKey' }, tt('settings.path')),
              h('code', { className: 'isx-path', title: library.dir || '' }, library.dir || tt('settings.pathMissing'))),
            h('div', { className: 'isx-stats' },
              h('div', { className: 'isx-stat' }, h('span', { className: 'isx-statValue' }, formatNumber(library.itemCount)), h('span', { className: 'isx-statLabel' }, tt('settings.items'))),
              h('div', { className: 'isx-stat' }, h('span', { className: 'isx-statValue' }, formatNumber(library.imageCount)), h('span', { className: 'isx-statLabel' }, tt('settings.images'))),
              h('div', { className: 'isx-stat' }, h('span', { className: 'isx-statValue' }, formatBytes(library.bytes)), h('span', { className: 'isx-statLabel' }, tt('settings.bytes')))))),
        h('section', { className: 'isx-section' },
          h('div', { className: 'isx-sectionHead' }, h('h2', { className: 'isx-sectionTitle' }, tt('settings.defaultsTitle'))),
          h('div', { className: 'isx-card isx-defaultsCard' },
            h('div', { className: 'isx-defaultsGrid' },
              h(Field, { label: tt('settings.defaultProvider') },
                h(Select, {
                  value: defaultProviderId,
                  disabled: defaultsBusy || !providers.length,
                  onChange: onDefaultProvider,
                  options: providers.map((provider) => ({ value: provider.id, label: provider.label || provider.id }))
                })),
              h(Field, { label: tt('settings.defaultModelLabel') },
                h(Select, {
                  value: defaults.model || '',
                  disabled: defaultsBusy || !modelOptions.length,
                  onChange: (value) => saveDefaults({ provider: defaultProviderId, model: value }),
                  options: modelOptions.length ? modelOptions : [{ value: '', label: tt('create.noModels') }]
                })),
              h(Field, { label: tt('settings.defaultAspect') },
                h(Select, {
                  value: defaults.aspect || '',
                  disabled: defaultsBusy,
                  onChange: (value) => saveDefaults({ aspect: value }),
                  options: aspectOptions
                })),
              h(Field, { label: tt('settings.defaultQuality') },
                h(Select, {
                  value: defaults.quality || '',
                  disabled: defaultsBusy,
                  onChange: (value) => saveDefaults({ quality: value }),
                  options: qualityOptions
                })),
              h(Field, { label: tt('settings.defaultCount') },
                h(Select, {
                  value: clampCount(defaults.count),
                  disabled: defaultsBusy,
                  onChange: (value) => saveDefaults({ count: clampCount(value) }),
                  options: countOptions
                }))))),
        h('section', { className: 'isx-section' },
          h('div', { className: 'isx-sectionHead' }, h('h2', { className: 'isx-sectionTitle' }, tt('settings.aboutTitle'))),
          h('div', { className: 'isx-about' },
            h('p', { className: 'isx-aboutLine' }, tt('settings.aboutLine', { version: bootstrap.version || '0.1.0' })),
            h('p', { className: 'isx-aboutBody' }, tt('settings.aboutBody')))))
    }
    //#endregion

    //#region Page shell
    function readStoredTab() {
      try {
        const value = window.localStorage.getItem(TAB_KEY)
        if (TABS.indexOf(value) >= 0) return value
      } catch (reason) {
        /* private mode / blocked storage */
      }
      return 'create'
    }
    let toastSeq = 0
    function StudioPage() {
      const [bootstrap, setBootstrap] = useState(null)
      const [loading, setLoading] = useState(true)
      const [bootError, setBootError] = useState(null)
      const [tab, setTab] = useState(readStoredTab)
      const [mountedTabs, setMountedTabs] = useState({ create: true })
      const [toast, setToast] = useState(null)
      const [refreshTick, setRefreshTick] = useState(0)
      const [pendingCreate, setPendingCreate] = useState(null)
      const [libraryFocus, setLibraryFocus] = useState(null)
      const [refreshing, setRefreshing] = useState(false)
      const [openingFolder, setOpeningFolder] = useState(false)
      const bootSeq = useRef(0)
      const nonceRef = useRef(0)

      const showToast = useCallback((text, tone) => {
        toastSeq += 1
        setToast({ id: toastSeq, text: String(text || ''), tone: tone || 'info' })
      }, [])

      useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(null), 2800)
        return () => clearTimeout(timer)
      }, [toast])

      const loadBootstrap = useCallback(async (quiet) => {
        const seq = ++bootSeq.current
        if (!quiet) setLoading(true)
        try {
          const data = await api('/bootstrap')
          if (seq !== bootSeq.current) return true
          setBootstrap(normalizeBootstrap(data))
          setBootError(null)
          return true
        } catch (reason) {
          if (seq !== bootSeq.current) return false
          if (quiet) {
            showToast(errMessage(reason), 'error')
          } else {
            setBootError(reason)
          }
          return false
        } finally {
          if (seq === bootSeq.current) setLoading(false)
        }
      }, [showToast])

      useEffect(() => {
        loadBootstrap(false)
      }, [loadBootstrap])

      useEffect(() => {
        try {
          window.localStorage.setItem(TAB_KEY, tab)
        } catch (reason) {
          /* storage unavailable */
        }
      }, [tab])

      useEffect(() => {
        setMountedTabs((current) => (current[tab] ? current : Object.assign({}, current, { [tab]: true })))
      }, [tab])

      const reloadBootstrap = useCallback(() => loadBootstrap(true), [loadBootstrap])
      const applyProviders = useCallback((list) => {
        setBootstrap((current) => (current ? Object.assign({}, current, { providers: Array.isArray(list) ? list : [] }) : current))
      }, [])
      const patchSettings = useCallback(async (patch) => {
        const data = await api('/settings', { method: 'PATCH', body: patch })
        const nextSettings = data && data.settings ? data.settings : null
        if (nextSettings) {
          setBootstrap((current) => {
            if (!current) return current
            const nextDefaults = Object.assign({}, current.defaults, nextSettings.defaults || {})
            nextDefaults.count = clampCount(nextDefaults.count)
            const nextTargets = nextSettings.ui && Array.isArray(nextSettings.ui.compareTargets) ? nextSettings.ui.compareTargets : current.compareTargets
            return Object.assign({}, current, { settings: nextSettings, defaults: nextDefaults, compareTargets: nextTargets })
          })
        }
        return nextSettings
      }, [])
      const openCreate = useCallback(() => setTab('create'), [])
      const openLibraryItem = useCallback((id) => {
        nonceRef.current += 1
        setLibraryFocus({ id: id, nonce: nonceRef.current })
        setTab('library')
      }, [])
      const useAsReference = useCallback((id) => {
        nonceRef.current += 1
        setPendingCreate({ refId: id, nonce: nonceRef.current })
        setTab('create')
      }, [])
      const usePromptAgain = useCallback((prompt) => {
        nonceRef.current += 1
        setPendingCreate({ prompt: prompt, nonce: nonceRef.current })
        setTab('create')
      }, [])
      const consumePreset = useCallback(() => setPendingCreate(null), [])

      function openFolder() {
        const dir = bootstrap && bootstrap.library ? bootstrap.library.dir : ''
        if (!dir || openingFolder) return
        setOpeningFolder(true)
        api('/reveal', { method: 'POST', body: { path: dir } })
          .then((data) => {
            const opened = !(data && data.ok === false)
            showToast(opened ? tt('shell.openedFolder') : tt('settings.revealFailed'), opened ? 'info' : 'error')
          })
          .catch((reason) => showToast(errMessage(reason), 'error'))
          .finally(() => setOpeningFolder(false))
      }
      function refreshAll() {
        if (refreshing) return
        setRefreshing(true)
        Promise.resolve(reloadBootstrap())
          .then((ok) => {
            setRefreshTick((value) => value + 1)
            showToast(ok === false ? tt('shell.bootErrorTitle') : tt('shell.refreshed'), ok === false ? 'error' : 'info')
          })
          .finally(() => setRefreshing(false))
      }
      function onTabKey(event) {
        const index = TABS.indexOf(tab)
        let next = -1
        if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
        else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = TABS.length - 1
        if (next < 0) return
        event.preventDefault()
        const nextTab = TABS[next]
        setTab(nextTab)
        try {
          const node = document.getElementById('isx-tab-' + nextTab)
          if (node && typeof node.focus === 'function') node.focus()
        } catch (reason) {
          /* ignore */
        }
      }

      const library = bootstrap ? bootstrap.library || {} : {}
      const providers = bootstrap ? bootstrap.providers : []
      const defaults = bootstrap ? bootstrap.defaults : {}
      const settings = bootstrap ? bootstrap.settings : {}
      let bodyContent = null
      if (!bootstrap) {
        bodyContent = bootError
          ? h('div', { className: 'isx-loadingWrap' }, h(ErrorCard, {
            title: tt('shell.bootErrorTitle'),
            message: errMessage(bootError),
            hint: tt('shell.bootErrorBody'),
            onCopy: (text) => copyText(text).then((ok) => showToast(ok ? tt('common.copied') : tt('errors.copyFailed'))),
            onSettings: null,
            onDismiss: null
          }), h(Btn, { variant: 'primary', busy: loading, onClick: () => loadBootstrap(false) }, tt('common.retry')))
          : h('div', { className: 'isx-loadingWrap' }, h('div', { className: 'isx-card isx-loadingCard', role: 'status', 'aria-live': 'polite' },
            h(Spinner, null),
            h('h2', { className: 'isx-emptyTitle' }, tt('shell.loadingTitle')),
            h('p', { className: 'isx-emptyBody' }, tt('shell.loadingBody'))))
      } else {
        bodyContent = h(React.Fragment, null,
          mountedTabs.create ? h('div', {
            className: 'isx-tabPane',
            hidden: tab !== 'create',
            role: 'tabpanel',
            id: 'isx-pane-create',
            'aria-labelledby': 'isx-tab-create'
          }, h(CreateTab, {
            active: tab === 'create',
            providers: providers,
            defaults: defaults,
            libraryDir: library.dir || '',
            pendingCreate: pendingCreate,
            onPresetConsumed: consumePreset,
            onOpenSettings: () => setTab('settings'),
            onOpenLibrary: openLibraryItem,
            showToast: showToast,
            reloadBootstrap: reloadBootstrap
          })) : null,
          mountedTabs.library ? h('div', {
            className: 'isx-tabPane',
            hidden: tab !== 'library',
            role: 'tabpanel',
            id: 'isx-pane-library',
            'aria-labelledby': 'isx-tab-library'
          }, h(LibraryTab, {
            active: tab === 'library',
            providers: providers,
            libraryDir: library.dir || '',
            refreshTick: refreshTick,
            focus: libraryFocus,
            onOpenCreate: openCreate,
            onUseReference: useAsReference,
            showToast: showToast,
            reloadBootstrap: reloadBootstrap
          })) : null,
          mountedTabs.compare ? h('div', {
            className: 'isx-tabPane',
            hidden: tab !== 'compare',
            role: 'tabpanel',
            id: 'isx-pane-compare',
            'aria-labelledby': 'isx-tab-compare'
          }, h(CompareTab, {
            active: tab === 'compare',
            providers: providers,
            defaults: defaults,
            settings: settings,
            compareTargets: bootstrap ? bootstrap.compareTargets : [],
            patchSettings: patchSettings,
            refreshTick: refreshTick,
            showToast: showToast,
            onOpenLibrary: openLibraryItem,
            onUsePrompt: usePromptAgain
          })) : null,
          mountedTabs.settings ? h('div', {
            className: 'isx-tabPane',
            hidden: tab !== 'settings',
            role: 'tabpanel',
            id: 'isx-pane-settings',
            'aria-labelledby': 'isx-tab-settings'
          }, h(SettingsTab, {
            bootstrap: bootstrap,
            providers: providers,
            settings: settings,
            defaults: defaults,
            patchSettings: patchSettings,
            reloadBootstrap: reloadBootstrap,
            onProviders: applyProviders,
            showToast: showToast
          })) : null)
      }

      return h('div', { className: 'isx-root' },
        h('style', null, CSS),
        h('header', { className: 'isx-head' },
          h('div', { className: 'isx-headText' },
            h('h1', { className: 'isx-title' }, tt('panel.title')),
            h('p', { className: 'isx-sub', title: library.dir || '' }, bootstrap
              ? pluralCount(library.itemCount, 'library.itemOne', 'library.itemMany') + ' \u00b7 ' + pluralCount(library.imageCount, 'library.imageOne', 'library.imageMany')
              : tt('shell.loadingSub'))),
          h('div', { className: 'isx-headActions' },
            h(Btn, {
              variant: 'ghost',
              icon: I.folder,
              'aria-label': tt('shell.openFolder'),
              title: tt('shell.openFolder'),
              disabled: !library.dir || openingFolder,
              busy: openingFolder,
              onClick: openFolder
            }, tt('shell.openFolder')),
            h(IconBtn, { icon: I.refresh, label: tt('shell.refresh'), busy: refreshing, disabled: refreshing || !bootstrap, onClick: refreshAll }))),
        h('div', { className: 'isx-tabsWrap' },
          h('div', { className: 'isx-tabs', role: 'tablist', 'aria-label': tt('shell.tabsLabel') },
            TABS.map((name) => h('button', {
              key: name,
              type: 'button',
              role: 'tab',
              id: 'isx-tab-' + name,
              className: 'isx-tab',
              'aria-selected': tab === name,
              'aria-controls': 'isx-pane-' + name,
              tabIndex: tab === name ? 0 : -1,
              onClick: () => setTab(name),
              onKeyDown: onTabKey
            }, tt('shell.tabs.' + name))))),
        h('div', { className: 'isx-body' }, bodyContent),
        toast ? h('div', { className: 'isx-toast', 'data-tone': toast.tone, role: 'status', 'aria-live': 'polite', key: toast.id }, toast.text) : null)
    }
    //#endregion

    //#region Stylesheet (theme tokens only; rendered inside the page tree)
    const CSS = `
.isx-root{box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45;container-type:inline-size}
.isx-root *,.isx-root *::before,.isx-root *::after{box-sizing:border-box}
.isx-root :focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);outline-offset:1px}
.isx-root :focus:not(:focus-visible){outline:none}
.isx-root button,.isx-root input,.isx-root select,.isx-root textarea{font:inherit;color:inherit}
.isx-root button{cursor:pointer}
.isx-root button:disabled{cursor:default}
.isx-head{flex:none;display:flex;align-items:center;gap:12px;padding:14px 18px 10px}
.isx-headText{flex:1;min-width:0}
.isx-title{margin:0;font-size:15px;font-weight:600;line-height:1.3;letter-spacing:-.01em}
.isx-sub{margin:2px 0 0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.isx-headActions{flex:none;display:flex;align-items:center;gap:6px}
.isx-tabsWrap{flex:none;padding:0 18px 12px;overflow-x:auto;scrollbar-width:none}
.isx-tabsWrap::-webkit-scrollbar{display:none}
.isx-tabs{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;max-width:100%}
.isx-tab{appearance:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 14px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;transition:background .14s ease-out,color .14s ease-out,border-color .14s ease-out}
.isx-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.isx-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-weight:600}
.isx-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.isx-tabPane{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.isx-tabPane[hidden]{display:none!important}
.isx-create{flex:1;min-height:0;display:grid;grid-template-columns:312px minmax(0,1fr);gap:14px;padding:0 18px 16px}
.isx-createEmpty{display:flex;align-items:center;justify-content:center}
.isx-rail{min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding:14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;scrollbar-gutter:stable}
.isx-work{min-width:0;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding-right:2px;scrollbar-gutter:stable}
.isx-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.isx-fieldLabel{font-size:12px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.isx-fieldLabelRow{display:flex;align-items:center;gap:6px;min-width:0}
.isx-hint{margin:0;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.isx-hint.isx-full{width:100%}
.isx-input,.isx-select,.isx-textarea{width:100%;min-width:0;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.4}
.isx-input,.isx-select{height:30px;padding:0 9px}
.isx-select{cursor:pointer}
.isx-textarea{padding:8px 10px;resize:none;overflow-y:auto;min-height:44px;transition:border-color .14s ease-out}
.isx-textareaSmall{font-size:12.5px}
.isx-input::placeholder,.isx-textarea::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-secondary) 75%,transparent)}
.isx-input:focus-visible,.isx-select:focus-visible,.isx-textarea:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.isx-selectWrap{position:relative;display:flex;align-items:center}
.isx-selectWrap .isx-select{padding-left:24px}
.isx-dot{position:absolute;left:9px;top:50%;transform:translateY(-50%);width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);pointer-events:none}
.isx-dot[data-state="on"]{background:var(--dsw-alias-state-success-primary)}
.isx-chips{display:flex;flex-wrap:wrap;gap:6px}
.isx-chipBtn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;transition:border-color .12s ease-out,background .12s ease-out,color .12s ease-out}
.isx-chipBtn:hover{color:var(--dsw-alias-label-primary)}
.isx-chipBtn[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-label-primary)}
.isx-ratio{width:16px;height:16px;display:inline-grid;place-items:center;flex:none}
.isx-ratioRect{display:inline-block;border:1.3px solid currentColor;border-radius:1px;opacity:.75}
.isx-stepper{display:inline-flex;align-items:center;gap:2px;height:30px;padding:0 2px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;align-self:flex-start}
.isx-stepperValue{min-width:22px;text-align:center;font-size:13px;font-variant-numeric:tabular-nums}
.isx-inline{display:flex;align-items:center;gap:6px;min-width:0}
.isx-end{justify-content:flex-end}
.isx-grow{flex:1;min-width:0}
.isx-refChips{display:flex;flex-direction:column;gap:6px;max-height:190px;overflow-y:auto;padding-right:2px}
.isx-refChip{display:flex;align-items:center;gap:8px;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);min-width:0}
.isx-refThumb{width:30px;height:30px;border-radius:6px;object-fit:cover;flex:none;background:var(--dsw-alias-bg-layer-1)}
.isx-refThumbEmpty{display:grid;place-items:center;color:var(--dsw-alias-label-secondary)}
.isx-refLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.isx-railFoot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);min-width:0}
.isx-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1;white-space:nowrap;text-decoration:none;transition:background .12s ease-out,border-color .12s ease-out,color .12s ease-out,opacity .12s ease-out}
.isx-btn[data-size="sm"]{height:26px;padding:0 9px;font-size:12px;border-radius:7px}
.isx-btn[data-variant="primary"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.isx-btn[data-variant="primary"]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,color-mix(in srgb,var(--dsw-alias-brand-primary) 86%,var(--dsw-alias-label-primary)))}
.isx-btn[data-variant="secondary"]:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.isx-btn[data-variant="ghost"]{border-color:transparent;color:var(--dsw-alias-label-secondary)}
.isx-btn[data-variant="ghost"]:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.isx-btn[data-variant="danger"]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent)}
.isx-btn[data-variant="danger"]:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.isx-btn:disabled{opacity:.45}
.isx-btn .isx-btnLabel{overflow:hidden;text-overflow:ellipsis}
.isx-iconBtn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);flex:none;text-decoration:none;transition:background .12s ease-out,color .12s ease-out,opacity .12s ease-out}
.isx-iconBtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.isx-iconBtn[aria-pressed="true"]{color:var(--dsw-alias-brand-primary)}
.isx-iconBtn:disabled{opacity:.35}
.isx-kbd{font-size:10.5px;line-height:1;padding:2px 4px;border:1px solid currentColor;border-radius:4px;opacity:.7}
.isx-pill{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;line-height:1;white-space:nowrap;border:1px solid transparent;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.isx-pill[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent)}
.isx-pill[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent)}
.isx-pill[data-tone="bad"]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent)}
.isx-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;font-size:10.5px;line-height:1;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}
.isx-tagBeta{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}
.isx-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px}
.isx-promptCard{padding:12px;display:flex;flex-direction:column;gap:10px}
.isx-promptEditor{display:flex;flex-direction:column;gap:8px;min-width:0}
.isx-promptMeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:24px}
.isx-count{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.isx-metaText{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.isx-metaDot{color:var(--dsw-alias-label-secondary);opacity:.6}
.isx-toggle{appearance:none;display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;transition:background .12s ease-out,color .12s ease-out}
.isx-toggle:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.isx-toggle[aria-pressed="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.isx-recent{position:relative;display:inline-flex}
.isx-chevronOpen{transform:rotate(180deg)}
.isx-popover{position:absolute;top:calc(100% + 6px);left:0;z-index:30;width:min(420px,78vw);max-height:280px;overflow-y:auto;padding:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 10px 28px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent)}
.isx-popoverStatus{display:flex;align-items:center;gap:8px;padding:8px 4px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.isx-popoverError{color:var(--dsw-alias-state-error-primary)}
.isx-popoverChips{display:flex;flex-direction:column;gap:4px}
.isx-chip{appearance:none;display:inline-flex;align-items:center;text-align:left;gap:6px;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.4;transition:border-color .12s ease-out,background .12s ease-out}
.isx-chip:hover{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.isx-chipPrompt{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.isx-promptActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:30px}
.isx-status{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;min-height:40px}
.isx-statusText{font-size:12.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.isx-spin{display:inline-block;width:14px;height:14px;flex:none;border-radius:50%;border:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent);border-top-color:var(--dsw-alias-brand-primary);animation:isx-spin .8s linear infinite}
.isx-spinOnBrand{border-color:color-mix(in srgb,currentColor 35%,transparent);border-top-color:currentColor}
@keyframes isx-spin{to{transform:rotate(360deg)}}
.isx-errorCard{padding:12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);display:flex;flex-direction:column;gap:8px}
.isx-errorHead{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-state-error-primary)}
.isx-errorTitle{font-size:13px;font-weight:600}
.isx-errorMsg{margin:0;font-size:12.5px;line-height:1.5;overflow-wrap:anywhere;white-space:pre-wrap}
.isx-errorHint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.isx-errorActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.isx-emptyWrap{flex:1;display:flex;align-items:center;justify-content:center;padding:24px 0;min-height:0}
.isx-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:26px 24px;max-width:520px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px}
.isx-emptyGlyph{width:52px;height:52px;border-radius:16px;display:grid;place-items:center;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);margin-bottom:2px}
.isx-emptyTitle{margin:0;font-size:15px;font-weight:600;line-height:1.35}
.isx-emptyBody{margin:0;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.isx-emptyActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:6px;width:100%}
.isx-exampleRow{display:flex;flex-direction:column;gap:6px;width:100%;margin-top:4px}
.isx-chipExample{width:100%;justify-content:flex-start;white-space:normal;text-align:left;line-height:1.45}
.isx-round{display:flex;flex-direction:column;gap:8px}
.isx-roundHead{display:flex;align-items:baseline;justify-content:space-between;gap:10px;min-width:0}
.isx-roundTitle{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.isx-grid{display:grid;gap:12px;grid-template-columns:minmax(0,1fr)}
.isx-grid[data-count="2"]{grid-template-columns:repeat(2,minmax(0,1fr))}
.isx-grid[data-count="3"],.isx-grid[data-count="4"]{grid-template-columns:repeat(2,minmax(0,1fr))}
.isx-grid[data-count="1"] .isx-shot{max-width:560px}
.isx-shot{position:relative;margin:0;min-width:0;border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.isx-shotOpen{display:block;width:100%;padding:0;border:0;background:transparent;cursor:zoom-in;position:relative}
.isx-plate{width:100%;background:var(--dsw-alias-bg-layer-2);position:relative;overflow:hidden;display:grid;place-items:center}
.isx-plateImg{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block}
.isx-shotBar{position:absolute;left:6px;right:6px;bottom:6px;display:flex;align-items:center;justify-content:space-between;gap:2px;padding:3px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);opacity:0;transform:translateY(4px);pointer-events:none;transition:opacity .14s ease-out,transform .14s ease-out}
.isx-shot:hover .isx-shotBar,.isx-shot:focus-within .isx-shotBar{opacity:1;transform:none;pointer-events:auto}
.isx-scrim{position:fixed;inset:0;z-index:70;display:grid;place-items:center;padding:28px;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 90%,transparent);overscroll-behavior:contain}
.isx-modal{width:100%;max-width:520px;max-height:min(82vh,760px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 24px 64px color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);overflow:hidden}
.isx-modalHead{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.isx-modalTitle{margin:0;font-size:15px;font-weight:600;flex:1;min-width:0}
.isx-modalBody{padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:12px;min-height:0}
.isx-modalFoot{display:flex;justify-content:flex-end;gap:8px;margin:4px -14px -14px;padding:12px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.isx-pickerTop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.isx-pickGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
.isx-pickItem{appearance:none;display:flex;flex-direction:column;gap:6px;padding:6px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);text-align:left;transition:border-color .12s ease-out,background .12s ease-out}
.isx-pickItem[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.isx-pickThumb{position:relative;display:block;aspect-ratio:1/1;border-radius:7px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.isx-pickImg{width:100%;height:100%;object-fit:cover;display:block}
.isx-pickCheck{position:absolute;top:5px;right:5px;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.isx-pickPrompt{font-size:11.5px;line-height:1.4;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:32px}
.isx-lbScrim{position:fixed;inset:0;z-index:90;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 94%,transparent);display:flex;flex-direction:column;padding:24px;overscroll-behavior:contain}
.isx-lb{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;width:100%}
.isx-lbStage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;width:100%}
.isx-lbImg{max-width:min(100%,1200px);max-height:calc(100vh - 180px);object-fit:contain;display:block;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.isx-lbBar{display:flex;align-items:center;gap:12px;max-width:min(100%,1200px);padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);min-width:0}
.isx-lbCaption{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.isx-lbActions{display:flex;align-items:center;gap:2px;flex:none}
.isx-lbClose{position:absolute;top:0;right:0;z-index:2;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.isx-lbNav{position:absolute;top:50%;transform:translateY(-50%);z-index:2;width:36px;height:36px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.isx-lbPrev{left:0}
.isx-lbNext{right:0}
.isx-lib{flex:1;min-height:0;display:flex;padding:0 18px 14px;gap:12px;position:relative}
.isx-libMain{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}
.isx-libFilters{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0 9px;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l1)}
.isx-searchWrap{position:relative;flex:1 1 200px;max-width:320px;min-width:140px;display:flex;align-items:center}
.isx-searchWrap svg{position:absolute;left:9px;color:var(--dsw-alias-label-secondary);pointer-events:none}
.isx-search{padding-left:28px}
.isx-libScroll{flex:1;min-height:0;overflow-y:auto;padding:12px 2px 8px;scrollbar-gutter:stable}
.isx-libGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.isx-libCard{position:relative;display:flex;flex-direction:column;min-width:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;transition:border-color .14s ease-out,box-shadow .14s ease-out}
.isx-libCard:hover{border-color:var(--dsw-alias-border-l2)}
.isx-libCard[data-selected="true"]{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent)}
.isx-libThumb{display:block;width:100%;aspect-ratio:1/1;padding:0;border:0;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.isx-libImg{width:100%;height:100%;object-fit:cover;display:block}
.isx-libFav{position:absolute;top:6px;right:6px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);opacity:0;transition:opacity .12s ease-out}
.isx-libCard:hover .isx-libFav,.isx-libCard:focus-within .isx-libFav,.isx-libFav[aria-pressed="true"]{opacity:1}
.isx-libFoot{display:flex;flex-direction:column;gap:4px;text-align:left;padding:8px 9px;border:0;background:transparent;min-width:0}
.isx-libPrompt{font-size:12.5px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;min-height:35px}
.isx-libMeta{font-size:11.5px;line-height:15px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.isx-loadMore{display:flex;justify-content:center;padding:16px 0 4px}
.isx-center{display:block;text-align:center;padding:14px 0}
.isx-skelCard{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:0 0 9px;overflow:hidden}
.isx-skelThumb{aspect-ratio:1/1;background:var(--dsw-alias-bg-layer-2);animation:isx-pulse 1.4s ease-in-out infinite}
.isx-skelLine{height:9px;margin:8px 9px 0;border-radius:4px;background:var(--dsw-alias-bg-layer-2);animation:isx-pulse 1.4s ease-in-out infinite}
.isx-skelShort{width:55%}
@keyframes isx-pulse{0%,100%{opacity:.5}50%{opacity:.85}}
.isx-drawer{width:420px;max-width:46%;flex:none;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-left-color:var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}
.isx-drawerHead{display:flex;align-items:center;gap:4px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.isx-drawerTitle{font-size:13px;font-weight:600;white-space:nowrap}
.isx-drawerScroll{flex:1;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:12px;scrollbar-gutter:stable}
.isx-drawerImage{width:100%;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;position:relative;display:grid;place-items:center}
.isx-drawerImg{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.isx-thumbs{display:flex;gap:6px;flex-wrap:wrap}
.isx-thumbBtn{width:46px;height:46px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);opacity:.7;transition:opacity .12s ease-out,border-color .12s ease-out}
.isx-thumbBtn img{width:100%;height:100%;object-fit:cover;display:block}
.isx-thumbBtn[aria-pressed="true"]{opacity:1;border-color:var(--dsw-alias-brand-primary)}
.isx-drawerBlock{display:flex;flex-direction:column;gap:6px;min-width:0}
.isx-blockHead{display:flex;align-items:center;gap:6px;min-width:0}
.isx-blockTitle{font-size:12px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-secondary);margin:0}
.isx-promptText{margin:0;font-size:12.5px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow-y:auto;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.isx-revised{display:flex;flex-direction:column;gap:4px;margin-top:4px}
.isx-fields{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.isx-fieldRow{display:flex;align-items:flex-start;gap:10px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}
.isx-fieldRow:last-child{border-bottom:0}
.isx-fieldKey{flex:none;width:88px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.isx-fieldVal{flex:1;min-width:0;font-size:12px;line-height:16px;overflow-wrap:anywhere}
.isx-tagEditor{display:flex;flex-wrap:wrap;gap:4px}
.isx-tagChip{display:inline-flex;align-items:center;gap:2px;height:22px;max-width:100%;min-width:0;padding:0 2px 0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:11.5px}
.isx-tagChip>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.isx-tagChip .isx-iconBtn{width:18px;height:18px;border-radius:50%}
.isx-stars{display:inline-flex;align-items:center;gap:0}
.isx-starBtn{appearance:none;width:26px;height:26px;padding:0;display:inline-grid;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);transition:color .12s ease-out,background .12s ease-out}
.isx-starBtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.isx-starBtn[aria-pressed="true"]{color:var(--dsw-alias-state-warn-primary)}
.isx-starBtn:disabled{opacity:.6}
.isx-notes{min-height:76px;resize:vertical;max-height:180px}
.isx-drawerActions{display:flex;flex-wrap:wrap;gap:6px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l1)}
.isx-scroll{flex:1;min-height:0;overflow-y:auto;padding:0 18px 18px;display:flex;flex-direction:column;gap:14px;scrollbar-gutter:stable}
.isx-compareCard{padding:12px;display:flex;flex-direction:column;gap:12px}
.isx-targetGroups{display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto;padding:2px}
.isx-targetGroup{display:flex;flex-direction:column;gap:4px}
.isx-targetGroupName{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.isx-targetChips{display:flex;flex-wrap:wrap;gap:6px}
.isx-targetChip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.isx-targetChip input{accent-color:var(--dsw-alias-brand-primary);margin:0;width:12px;height:12px}
.isx-targetChip[data-checked="true"]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-label-primary)}
.isx-cols{display:grid;gap:12px;overflow-x:auto;padding-bottom:4px;align-items:stretch}
.isx-col{min-width:0;display:flex;flex-direction:column;gap:8px;padding:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px}
.isx-colHead{display:flex;flex-direction:column;gap:4px;min-width:0}
.isx-colTitle{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.isx-colMeta{display:flex;align-items:center;gap:8px}
.isx-colBody{border-radius:9px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.isx-colEmpty{display:grid;place-items:center;min-height:160px;font-size:12px;color:var(--dsw-alias-label-secondary);padding:16px}
.isx-colError{display:flex;gap:8px;padding:12px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}
.isx-colError p{margin:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.isx-colFoot{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.isx-runs{display:flex;flex-direction:column;gap:6px}
.isx-runRow{appearance:none;display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;transition:border-color .14s ease-out,background .14s ease-out}
.isx-runRow:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.isx-runRow[data-active="true"]{border-color:var(--dsw-alias-brand-primary)}
.isx-runText{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.isx-runPrompt{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.isx-runMeta{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.isx-runThumbs{display:flex;gap:4px;flex:none}
.isx-runThumb{width:34px;height:34px;border-radius:6px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);display:block}
.isx-runThumb img{width:100%;height:100%;object-fit:cover;display:block}
.isx-section{display:flex;flex-direction:column;gap:10px}
.isx-sectionHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.isx-sectionTitle{margin:0;font-size:14px;font-weight:600}
.isx-sectionHint{margin:0;flex:1 1 100%;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.isx-providerList{display:flex;flex-direction:column;gap:10px}
.isx-providerCard{padding:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;display:flex;flex-direction:column;gap:12px}
.isx-providerHead{display:flex;align-items:center;gap:10px;min-width:0}
.isx-ambient{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:8px 10px}
.isx-ambientLine{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary)}
.isx-ambientMeta{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.isx-ambient .isx-hint{margin:0}
.isx-providerIcon{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;flex:none;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.isx-providerName{display:flex;flex-direction:column;gap:1px;min-width:0}
.isx-providerTitle{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.isx-providerBody{display:flex;flex-direction:column;gap:10px}
.isx-row{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}
.isx-rowControl{flex:1 1 180px;min-width:140px}
.isx-testOk{font-size:11.5px;color:var(--dsw-alias-state-success-primary);line-height:1.4}
.isx-testBad{font-size:11.5px;color:var(--dsw-alias-state-error-primary);line-height:1.4;overflow-wrap:anywhere}
.isx-badgeRow{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:2px}
.isx-link{appearance:none;display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.4;text-decoration:none;cursor:pointer;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent)}
.isx-link:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.isx-link:disabled{opacity:.45}
.isx-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.isx-libraryCard{padding:12px;display:flex;flex-direction:column;gap:10px}
.isx-pathRow{display:flex;align-items:baseline;gap:10px;min-width:0}
.isx-path{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere;background:var(--dsw-alias-bg-layer-2);padding:5px 8px;border-radius:6px;flex:1;min-width:0}
.isx-stats{display:flex;gap:24px;flex-wrap:wrap}
.isx-stat{display:flex;flex-direction:column;gap:1px}
.isx-statValue{font-size:16px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums}
.isx-statLabel{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.isx-defaultsCard{padding:12px}
.isx-defaultsGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.isx-about{display:flex;flex-direction:column;gap:4px}
.isx-aboutLine{margin:0;font-size:13px;font-weight:600}
.isx-aboutBody{margin:0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);max-width:680px}
.isx-loadingWrap{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px}
.isx-loadingCard{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:28px 32px;max-width:440px}
.isx-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:100;max-width:min(560px,80vw);padding:9px 14px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);font-size:12.5px;color:var(--dsw-alias-label-primary);animation:isx-rise .16s ease-out;pointer-events:none}
.isx-toast[data-tone="error"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);color:var(--dsw-alias-state-error-primary)}
@keyframes isx-rise{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}
@container (max-width: 860px){.isx-create{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}.isx-create .isx-rail{max-height:46vh}.isx-drawer{position:absolute;top:0;right:0;bottom:0;width:min(420px,100%);max-width:none;z-index:6;box-shadow:-16px 0 40px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent)}.isx-head{padding:12px 12px 8px}.isx-tabsWrap{padding:0 12px 10px}.isx-scroll,.isx-create,.isx-lib{padding-left:12px;padding-right:12px}}
@container (max-width: 620px){.isx-drawer{width:100%}.isx-headActions .isx-btn .isx-btnLabel{display:none}.isx-tab{padding:0 10px}.isx-lbNav{width:30px;height:30px}.isx-lbScrim{padding:12px}.isx-lbBar{flex-direction:column;align-items:stretch}.isx-lbActions{justify-content:flex-end}}
@media (prefers-reduced-motion: reduce){.isx-root *,.isx-root *::before,.isx-root *::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}.isx-spin{animation:none!important}.isx-shotBar{transition:none!important}}
`
    //#endregion

    //#region Module entry
    /** Services this client half needs (SPEC.md section 5). */
    const inject = ['slots', 'locale', 'layout']

    /** Sidebar glyph: the shell owns the row, we only draw the 16x16 mark. */
    function StudioIcon(props) {
      return h(IconStudio, { size: (props && props.size) || 16 })
    }

    /** Registration cannot take the whole plugin down when a seat is missing. */
    function safeRegister(slots, entry, component) {
      try {
        const dispose = slots.register(entry, component)
        return typeof dispose === 'function' ? dispose : function () {}
      } catch (reason) {
        safeLog(reason)
        return function () {}
      }
    }

    /**
     * Register both seats and the dictionaries, and hand cordis one disposer
     * that releases everything this plugin created (locale + both slots).
     */
    function apply(ctx) {
      if (!ctx || typeof ctx.effect !== 'function') {
        safeLog(new Error('image-studio: client context unavailable'))
        return
      }
      try {
        ctx.effect(() => {
          const disposers = []
          try {
            if (ctx.locale && typeof ctx.locale.register === 'function') {
              const offLocale = ctx.locale.register(NS, { zh: zh, en: en })
              if (typeof offLocale === 'function') disposers.push(offLocale)
            }
            if (ctx.locale && typeof ctx.locale.bind === 'function') runtimeTranslate = ctx.locale.bind(NS)
          } catch (reason) {
            safeLog(reason)
          }
          const slots = (ctx && ctx.slots) || (ctx && typeof ctx.get === 'function' ? ctx.get('slots') : null)
          if (slots && typeof slots.inject === 'function') {
            disposers.push(slots.inject('sidebar.panellist', () => safeRegister(slots, {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              label: () => tt('panel.title')
            }, StudioIcon)))
            disposers.push(slots.inject('main', () => safeRegister(slots, {
              name: 'main',
              key: PANEL_ID
            }, StudioPage)))
          } else {
            safeLog(new Error('image-studio: slots service unavailable'))
          }
          return () => {
            while (disposers.length) {
              const dispose = disposers.pop()
              try {
                if (typeof dispose === 'function') dispose()
              } catch (reason) {
                safeLog(reason)
              }
            }
            runtimeTranslate = null
          }
        }, 'image-studio: panel seats')
      } catch (reason) {
        safeLog(reason)
      }
    }
    //#endregion

    return { inject: inject, apply: apply }
  }
})
