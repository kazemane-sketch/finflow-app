// src/components/TagInput.tsx
import { useState, KeyboardEvent } from 'react'
import { X } from 'lucide-react'

interface TagInputProps {
  value: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
  className?: string
}

export default function TagInput({ value, onChange, placeholder, className }: TagInputProps) {
  const [input, setInput] = useState('')

  const addTag = (raw: string) => {
    const tag = raw.trim()
    if (tag && !value.includes(tag)) {
      onChange([...value, tag])
    }
    setInput('')
  }

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(input)
    }
    if (e.key === 'Backspace' && !input && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  const removeTag = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx))
  }

  return (
    <div className={`flex flex-wrap items-center gap-1 border rounded-md px-2 py-1.5 bg-white focus-within:ring-2 focus-within:ring-sky-500/30 focus-within:border-sky-400 min-h-[36px] ${className || ''}`}>
      {value.map((tag, i) => (
        <span key={i} className="inline-flex items-center gap-0.5 bg-slate-100 text-slate-700 text-xs font-medium px-1.5 py-0.5 rounded">
          {tag}
          <button type="button" onClick={() => removeTag(i)} className="text-slate-400 hover:text-red-500">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKey}
        onBlur={() => input && addTag(input)}
        placeholder={value.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[80px] text-sm outline-none bg-transparent"
      />
    </div>
  )
}
