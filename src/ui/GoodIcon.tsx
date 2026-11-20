import { useState } from 'react'

/**
 * Иконка товара (Этап 10f): AI-арт 256² из assets/goods/<id>.png,
 * ужимаемый CSS до 20–32 px. Фолбэк по плану — текст: если картинка
 * не загрузилась, <img> просто исчезает, подпись рядом остаётся всегда.
 */
export function GoodIcon({ id, className }: { id: string; className?: string }) {
  const [broken, setBroken] = useState(false)
  if (broken) return null
  return (
    <img
      className={`good-ico${className ? ` ${className}` : ''}`}
      src={`assets/goods/${id}.png`}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setBroken(true)}
    />
  )
}
