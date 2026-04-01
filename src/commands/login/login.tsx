import { feature } from 'bun:bundle'
import * as React from 'react'
import { useState } from 'react'
import { resetCostState } from '../../bootstrap/state.js'
import { clearTrustedDeviceToken, enrollTrustedDevice } from '../../bridge/trustedDevice.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { Select } from '../../components/CustomSelect/select.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import TextInput from '../../components/TextInput.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Box, Text } from '../../ink.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { saveApiKey } from '../../utils/auth.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { resetUserCache } from '../../utils/user.js'
import { performLogout } from '../logout/logout.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return (
    <Login
      onDone={async (success, selectedModel) => {
        context.onChangeAPIKey()

        // Signature-bearing blocks (thinking, connector_text) are bound to the API key —
        // strip them so the new key doesn't reject stale signatures.
        context.setMessages(stripSignatureBlocks)

        if (success) {
          // Apply model preference immediately for current session.
          if (selectedModel) {
            context.setAppState(prev => ({
              ...prev,
              mainLoopModel: selectedModel,
              mainLoopModelForSession: null,
            }))
          }

          // Post-login refresh logic. Keep in sync with onboarding in src/interactiveHelpers.tsx
          resetCostState()
          void refreshRemoteManagedSettings()
          void refreshPolicyLimits()
          resetUserCache()
          refreshGrowthBookAfterAuthChange()
          clearTrustedDeviceToken()
          void enrollTrustedDevice()

          resetBypassPermissionsCheck()
          const appState = context.getAppState()
          void checkAndDisableBypassPermissionsIfNeeded(
            appState.toolPermissionContext,
            context.setAppState,
          )
          if (feature('TRANSCRIPT_CLASSIFIER')) {
            resetAutoModeGateCheck()
            void checkAndDisableAutoModeIfNeeded(
              appState.toolPermissionContext,
              context.setAppState,
              appState.fastMode,
            )
          }

          context.setAppState(prev => ({
            ...prev,
            authVersion: prev.authVersion + 1,
          }))
        }

        onDone(success ? 'Login successful' : 'Login interrupted')
      }}
    />
  )
}

type LoginMode = 'menu' | 'oauth' | 'custom'

export function Login(props: {
  onDone: (success: boolean, selectedModel?: string) => void
  startingMessage?: string
}): React.ReactNode {
  const mainLoopModel = useMainLoopModel()
  const [mode, setMode] = useState<LoginMode>('menu')

  return (
    <Dialog
      title="Login"
      onCancel={() => props.onDone(false, mainLoopModel)}
      color="permission"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      {mode === 'menu' ? (
        <Box flexDirection="column" gap={1}>
          <Text bold>Choose login method:</Text>
          <Select
            options={[
              {
                label: (
                  <Text>
                    OAuth login{' '}
                    <Text dimColor>
                      (Subscription / Console / 3rd-party)
                    </Text>
                  </Text>
                ),
                value: 'oauth',
              },
              {
                label: (
                  <Text>
                    Custom API endpoint{' '}
                    <Text dimColor>
                      (manual URL + API key + model preferences)
                    </Text>
                  </Text>
                ),
                value: 'custom',
              },
            ]}
            onChange={value => {
              if (value === 'custom') {
                setMode('custom')
                return
              }
              setMode('oauth')
            }}
          />
        </Box>
      ) : null}

      {mode === 'oauth' ? (
        <ConsoleOAuthFlow
          onDone={() => props.onDone(true, mainLoopModel)}
          startingMessage={props.startingMessage}
        />
      ) : null}

      {mode === 'custom' ? (
        <CustomApiConfig
          fallbackModel={mainLoopModel}
          onDone={props.onDone}
        />
      ) : null}
    </Dialog>
  )
}

function sanitizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '')
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function CustomApiConfig(props: {
  fallbackModel: string
  onDone: (success: boolean, selectedModel?: string) => void
}): React.ReactNode {
  const [baseUrl, setBaseUrl] = useState('https://api.anthropic.com')
  const [apiKey, setApiKey] = useState('')
  const [primaryModel, setPrimaryModel] = useState(props.fallbackModel)
  const [secondaryModel, setSecondaryModel] = useState('')
  const [step, setStep] = useState(0)
  const [cursorOffset, setCursorOffset] = useState(0)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (isSaving) return

    const normalizedUrl = sanitizeBaseUrl(baseUrl)
    const trimmedKey = apiKey.trim()
    const trimmedPrimaryModel = primaryModel.trim()
    const trimmedSecondaryModel = secondaryModel.trim()

    if (!isValidHttpUrl(normalizedUrl)) {
      setError('Base URL must be a valid http/https URL.')
      return
    }
    if (!trimmedKey) {
      setError('API key is required.')
      return
    }
    if (
      trimmedPrimaryModel &&
      trimmedSecondaryModel &&
      trimmedPrimaryModel === trimmedSecondaryModel
    ) {
      setError('Primary and secondary model should be different.')
      return
    }

    setError(null)
    setIsSaving(true)

    try {
      // Switch to API-key auth mode by clearing OAuth credentials first.
      await performLogout({ clearOnboarding: false })
      await saveApiKey(trimmedKey)

      const settingsUpdate = updateSettingsForSource('userSettings', {
        env: {
          ANTHROPIC_BASE_URL: normalizedUrl,
          ...(trimmedSecondaryModel
            ? { ANTHROPIC_SMALL_FAST_MODEL: trimmedSecondaryModel }
            : {}),
        },
        ...(trimmedPrimaryModel ? { model: trimmedPrimaryModel } : {}),
      })

      if (settingsUpdate.error) {
        throw settingsUpdate.error
      }

      props.onDone(true, trimmedPrimaryModel || props.fallbackModel)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(`Failed to save custom configuration: ${message}`)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Custom API configuration</Text>
      <Text dimColor>
        Press Enter to move to next field. On the last field, Enter will save.
      </Text>

      <Box flexDirection="column" gap={1}>
        <Text>
          1. Base URL{step === 0 ? ' >' : ''}: <Text dimColor>{baseUrl}</Text>
        </Text>
        {step === 0 ? (
          <TextInput
            value={baseUrl}
            onChange={setBaseUrl}
            onSubmit={() => {
              setCursorOffset(0)
              setStep(1)
            }}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            columns={90}
            focus
            showCursor
          />
        ) : null}

        <Text>
          2. API Key{step === 1 ? ' >' : ''}:{' '}
          <Text dimColor>{apiKey ? '*'.repeat(Math.min(apiKey.length, 24)) : '(empty)'}</Text>
        </Text>
        {step === 1 ? (
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            onSubmit={() => {
              setCursorOffset(0)
              setStep(2)
            }}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            columns={90}
            focus
            showCursor
            mask="*"
          />
        ) : null}

        <Text>
          3. Primary model{step === 2 ? ' >' : ''}: <Text dimColor>{primaryModel || '(default)'}</Text>
        </Text>
        {step === 2 ? (
          <TextInput
            value={primaryModel}
            onChange={setPrimaryModel}
            onSubmit={() => {
              setCursorOffset(0)
              setStep(3)
            }}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            columns={90}
            focus
            showCursor
            placeholder="e.g. claude-sonnet-4-6"
          />
        ) : null}

        <Text>
          4. Secondary model (optional){step === 3 ? ' >' : ''}:{' '}
          <Text dimColor>{secondaryModel || '(empty)'}</Text>
        </Text>
        {step === 3 ? (
          <TextInput
            value={secondaryModel}
            onChange={setSecondaryModel}
            onSubmit={() => {
              void submit()
            }}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            columns={90}
            focus
            showCursor
            placeholder="e.g. claude-haiku-4-5"
          />
        ) : null}
      </Box>

      {error ? <Text color="error">{error}</Text> : null}

      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          Secondary model maps to <Text bold>ANTHROPIC_SMALL_FAST_MODEL</Text>.
        </Text>
        <Text dimColor>
          Press Esc to cancel dialog, or select OAuth mode from the previous menu.
        </Text>
        {isSaving ? <Text>Saving configuration...</Text> : null}
        {!isSaving ? (
          <Text dimColor>
            Need to switch mode? <Text bold>Type /login</Text> again and choose OAuth.
          </Text>
        ) : null}
        {!isSaving ? (
          <Text dimColor>
            Quick back: <Text bold>Ctrl+C</Text> to cancel this dialog.
          </Text>
        ) : null}
        {!isSaving ? (
          <Text dimColor>
            To return now: <Text bold>Esc</Text> then run <Text bold>/login</Text>.
          </Text>
        ) : null}
      </Box>

    </Box>
  )
}
