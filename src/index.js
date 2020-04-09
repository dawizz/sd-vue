import jwtDecode from 'jwt-decode'

function jwtDecodeAlive (jwt) {
  if (!jwt) return null
  const decoded = jwtDecode(jwt)
  if (!decoded) return null
  const now = Date.now().valueOf() / 1000
  if (typeof decoded.exp !== 'undefined' && decoded.exp < now) {
    console.error(`token expired: ${JSON.stringify(decoded)}`)
    return null
  }
  if (typeof decoded.nbf !== 'undefined' && decoded.nbf > now) {
    console.error(`token expired: ${JSON.stringify(decoded)}`)
    return null
  }
  return decoded
}

function goTo (url) {
  try {
    window.top.location.href = url
  } catch (err) {
    console.error('Failed to navigate in top window')
    window.location.href = url
  }
}

export const sessionStoreBuilder = () => ({
  namespaced: true,
  state: {
    user: null,
    initialized: false,
    baseUrl: null,
    logoutRedirectUrl: null,
    cookieName: 'id_token',
    cookieDomain: null,
    interval: 10000,
    autoKeepalive: 300000, // 5 minutes by default
    httpLib: null
  },
  getters: {
    loginUrl(state) {
      return (redirect, noImmediate) => {
        // Login can also be used to redirect user immediately if he is already logged
        // shorter than "logIfNecessaryOrRedirect"
        if (redirect && state.user && !noImmediate) return redirect
        redirect = redirect && typeof redirect === 'string' ? redirect : `${window.location.origin}${window.location.pathname}`
        if (redirect.indexOf('?') === -1) redirect += '?id_token='
        else redirect += '&id_token='
        return `${state.baseUrl}/login?redirect=${encodeURIComponent(redirect)}`
      }
    },
    activeAccount(state) {
      if (!state.user) return null
      if (state.user.organization) {
        return {
          type: 'organization',
          id: state.user.organization.id,
          name: state.user.organization.name
        }
      } else {
        return {
          type: 'user',
          id: state.user.id,
          name: state.user.name
        }
      }
    }
  },
  mutations: {
    setAny(state, params) {
      // Replace undefined with null to prevent breaking reactivity
      Object.keys(params).forEach(k => {
        if (params[k] === undefined) params[k] = null
      })
      Object.assign(state, params)
    },
    updateUser(state, user) {
      if (state.user && state.user.id === user.id) Object.assign(state.user, user)
      else state.user = user
    }
  },
  actions: {
    login({ getters }, redirect) {
      goTo(getters.loginUrl(redirect))
    },
    logout({ commit, state }) {
      const httpLib = state.httpLib || this.$axios
      if (!httpLib) {
        console.error('No http client found to send logout action. You should pass Vue.http or Vue.axios as init param.')
        return
      }
      return httpLib.post(`${state.baseUrl}/logout`).then(() => {
        if (state.logoutRedirectUrl) {
          return goTo(state.logoutRedirectUrl)
        }
        commit('setAny', { user: null })
      })
    },
    switchOrganization({ state, commit, dispatch }, organizationId) {
      if (organizationId) this.cookies.set(`${state.cookieName}_org`, organizationId, { domain: state.cookieDomain, path: '/' })
      else this.cookies.set(`${state.cookieName}_org`, '', { domain: state.cookieDomain, path: '/' })
      dispatch('readCookie')
    },
    setAdminMode({ state, dispatch, getters }, params) {
      let adminMode, redirect
      if (typeof params === 'boolean') {
        adminMode = params
      } else {
        adminMode = params.value
        redirect = params.redirect
      }
      if (adminMode) {
        let url = getters.loginUrl(redirect, false)
        if (state.user) url += `&email=${encodeURIComponent(state.user.email)}`
        goTo(url + `&adminMode=true`)
      } else {
        const httpLib = state.httpLib || this.$axios
        if (!httpLib) {
          console.error('No http client found to send logout action. You should pass Vue.http or Vue.axios as init param.')
          return
        }
        httpLib.delete(`${state.baseUrl}/adminmode`).then(() => {
          dispatch('readCookie')
          goTo(redirect || state.logoutRedirectUrl || '/')
        })
      }
    },
    keepalive({ state, dispatch }) {
      if (!state.user) return
      const httpLib = state.httpLib || this.$axios
      if (httpLib) {
        return httpLib.post(`${state.baseUrl}/keepalive`).then(res => {
          dispatch('readCookie')
          return res.data || res.body
        })
      } else console.error('No http client found to send keepalive action. You should pass Vue.http or Vue.axios as init param.')
    },
    asAdmin({ state, dispatch }, user) {
      const httpLib = state.httpLib || this.$axios
      if (httpLib) {
        if (user) {
          httpLib.post(`${state.baseUrl}/asadmin`, user).then(() => {
            dispatch('readCookie')
            goTo(state.logoutRedirectUrl || '/')
          })
        } else {
          httpLib.delete(`${state.baseUrl}/asadmin`).then(() => {
            dispatch('readCookie')
            goTo(state.logoutRedirectUrl || '/')
          })
        }
      } else console.error('No http client found to send keepalive action. You should pass Vue.http or Vue.axios as init param.')
    },
    init({ commit, dispatch }, params) {
      if (!params.cookies) {
        throw new Error('You must init @koumoul/sd-vue vith a "cookies" wrapper with simple get and set methods like js-cookie, cookie-universal-nuxt or other')
      }
      this.cookies = params.cookies
      delete params.cookies
      commit('setAny', params)
      dispatch('readCookie')
    },
    readCookie({ state, commit }) {
      const cookie = this.cookies.get(state.cookieName)
      if (cookie) {
        const user = jwtDecodeAlive(cookie)
        if (user) {
          const organizationId = this.cookies.get(`${state.cookieName}_org`)
          if (organizationId) {
            user.organization = (user.organizations || []).find(o => o.id === organizationId)

            // consumerFlag is used by applications to decide if they should ask confirmation to the user
            // of the right quotas or other organization related context to apply
            // it is 'user' if id_token_org is an empty string or is equal to 'user'
            // it is null if id_token_org is absent or if it does not match an organization of the current user
            // it is the id of the orga in id_token_org
            if (user.organization) {
              user.consumerFlag = user.organization.id
            } else if (organizationId.toLowerCase() === 'user') {
              user.consumerFlag = 'user'
            }
          } else {
            user.organization = null
          }
        }
        commit('updateUser', user)
      } else {
        commit('setAny', { user: null })
      }
      commit('setAny', { initialized: true })
    },
    loop({ state, dispatch }, cookies) {
      if (!this.cookies && !cookies) {
        throw new Error('You must init @koumoul/sd-vue vith a "cookies" wrapper with simple get and set methods like js-cookie, cookie-universal-nuxt or other')
      }
      this.cookies = this.cookies || cookies

      setTimeout(() => {
        dispatch('readCookie')
        setInterval(() => dispatch('readCookie'), state.interval)
        if (state.autoKeepalive) {
          dispatch('keepalive')
          setInterval(() => dispatch('keepalive'), state.autoKeepalive)
        }
      }, 0)
    }
  }
})

export const sessionStore = sessionStoreBuilder()
