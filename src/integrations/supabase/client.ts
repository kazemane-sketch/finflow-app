import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://xtuofcwvimaffcpqboou.supabase.co'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0dW9mY3d2aW1hZmZjcHFib291Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNjIyMTUsImV4cCI6MjA4NzYzODIxNX0.kShgRlGkLFkq08kW_Le5G8N0dVbidX08ho6WQ3n9kkw'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
