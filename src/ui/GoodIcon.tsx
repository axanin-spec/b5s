import { useState } from 'react'

/**
 * База иконок (Этап 10f/13): AI-арт, ужимаемый CSS до 20–32 px.
 * Фолбэк по плану — текст: если картинка не загрузилась, <img> просто исчезает,
 * подпись рядом остаётся всегда.
 */
function IconImg({ src, className }: { src: string; className?: string }) {
  const [broken, setBroken] = useState(false)
  if (broken) return null
  return (
    <img
      className={`good-ico${className ? ` ${className}` : ''}`}
      src={src}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setBroken(true)}
    />
  )
}

/** Иконка товара: assets/goods/<id>.png. */
export function GoodIcon({ id, className }: { id: string; className?: string }) {
  return <IconImg src={`assets/goods/${id}.png`} className={className} />
}

/** Иконка линии модулей (Этап 13): assets/equip/<line>.png; ранг — чип рядом. */
export function EquipIcon({ line, className }: { line: string; className?: string }) {
  return <IconImg src={`assets/equip/${line}.png`} className={className} />
}
