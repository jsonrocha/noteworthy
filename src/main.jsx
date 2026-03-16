import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Noteworthy from './noteworthy.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Noteworthy />
  </StrictMode>
)