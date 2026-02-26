import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { toast } from 'sonner'

export default function AuthPage() {
  const { signInWithEmail, signUp } = useAuth()
  const [isRegister, setIsRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    const { error } = isRegister
      ? await signUp(email, password)
      : await signInWithEmail(email, password)
    setLoading(false)

    if (error) {
      toast.error(error.message)
    } else if (isRegister) {
      toast.success('Account creato! Controlla la tua email per confermare.')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground font-extrabold text-lg">F</div>
          <span className="text-2xl font-bold tracking-tight">FinFlow</span>
        </div>

        <Card>
          <CardHeader className="text-center">
            <CardTitle>{isRegister ? 'Crea Account' : 'Accedi'}</CardTitle>
            <CardDescription>
              {isRegister
                ? 'Registrati per iniziare a gestire le tue finanze'
                : 'Accedi al tuo pannello di gestione finanziaria'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email" type="email" placeholder="nome@azienda.it"
                  value={email} onChange={e => setEmail(e.target.value)} required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password" type="password" placeholder="••••••••"
                  value={password} onChange={e => setPassword(e.target.value)}
                  required minLength={6}
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Caricamento...' : isRegister ? 'Registrati' : 'Accedi'}
              </Button>
            </form>
            <div className="mt-4 text-center text-sm text-muted-foreground">
              {isRegister ? 'Hai già un account?' : 'Non hai un account?'}{' '}
              <button
                type="button"
                className="text-primary hover:underline font-medium"
                onClick={() => setIsRegister(!isRegister)}
              >
                {isRegister ? 'Accedi' : 'Registrati'}
              </button>
            </div>
          </CardContent>
        </Card>

        <p className="text-xs text-center text-muted-foreground mt-6">
          Gestione finanziaria per PMI italiane
        </p>
      </div>
    </div>
  )
}
