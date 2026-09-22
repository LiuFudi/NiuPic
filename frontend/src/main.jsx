// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LiuFudi
//
// This file is part of NiuPic, licensed under the GNU General Public
// License version 3 or (at your option) any later version.
// See the LICENSE file for the full text.

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AuthWrapper from './components/AuthWrapper'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthWrapper>
      <App />
    </AuthWrapper>
  </React.StrictMode>,
)
