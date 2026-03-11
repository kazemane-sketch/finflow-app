// src/pages/admin/TestLabPage.tsx
import { FlaskConical } from 'lucide-react'

export default function TestLabPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] text-center px-6">
      <div className="h-20 w-20 rounded-2xl bg-slate-100 flex items-center justify-center mb-6">
        <FlaskConical className="h-10 w-10 text-slate-400" />
      </div>
      <h1 className="text-2xl font-bold text-slate-900 mb-2">Test Lab</h1>
      <p className="text-sm text-slate-500 max-w-md mb-6">
        Qui potrai testare gli agent su fatture reali, vedere la prompt completa,
        l'output, il reasoning e confrontare con classificazioni confermate.
      </p>
      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-100 text-amber-700 text-xs font-semibold">
        🧪 Coming in Fase 4
      </span>
    </div>
  )
}
