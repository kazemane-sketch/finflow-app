import { createClient } from '@supabase/supabase-js'

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://xtuofcwvimaffcpqboou.supabase.co'
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVja2Z2a256ZnFwZnVsZXF3ZXdnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwMjA4NjcsImV4cCI6MjA4NzU5Njg2N30.D448-tCP4zR35et4-XikXCApAstaVYLOCynqfqKVL10'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
