import { useNavigate, useLocation } from '@tanstack/react-router'
import { ArrowLeft, Loader2, UserRound, type LucideIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AccountAvatar } from '@/components/account-avatar'
import { FilePickerInput } from '@/components/file-picker-input'
import { PageShell } from '@/components/layout/page-shell'
import { RequireAuth } from '@/components/require-auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { prepareProfileImage, uploadToPresignedUrl } from '@/lib/upload'
import { useCurrentAccount } from '@/lib/use-current-account'
import { useHashTargetFocus } from '@/lib/use-hash-target-focus'
import { cn } from '@/lib/utils'
import { trpc } from '@/trpc/client'

import { AccountEmailSettings } from './account-email-settings'
import { AccountExportModal } from './account-export-modal'
import { AccountPasswordSettings } from './account-password-settings'
import { AccountPreferences } from './account-preferences'
import { AccountAiPreferences } from './ai-preferences'
import { AnonymousAccountSettings } from './anonymous-account-settings'
import { AuthorizedClients } from './authorized-clients'
import { NotificationsPreferences } from './notifications-preferences'
import {
  SettingsFieldRow,
  SettingsList,
  SettingsRow,
  SettingsSection,
  settingsControlId,
} from './settings-ui'

/**
 * Account settings page. Allows a signed-in user to update their display name
 * and add or change a verified email. Reuses the same `account.updateProfile`
 * mutation as the magic-link `complete-profile` flow, with matching validation
 * (trimmed name, 2-50 characters).
 */
export function AccountSettingsPage() {
  return (
    <RequireAuth>
      <AccountSettingsContent />
    </RequireAuth>
  )
}

function AccountSettingsContent() {
  const { t } = useTranslation(undefined, { keyPrefix: 'AccountSettings' })
  const { t: tCommon } = useTranslation(undefined, { keyPrefix: 'Header' })
  const { data: account, isPending, refetch } = useCurrentAccount()
  const navigate = useNavigate()
  const { hash } = useLocation()
  useHashTargetFocus(hash)
  const utils = trpc.useUtils()
  const { toast } = useToast()

  const [dirtyName, setDirtyName] = useState<string | null>(null)
  const name = dirtyName ?? account?.name ?? ''
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isUploadingImage, setIsUploadingImage] = useState(false)
  const imageInputRef = useRef<HTMLInputElement>(null)

  async function refreshAccount() {
    // Bust better-auth's cookie-cached session so the account menu
    // (and anywhere else reading the session) updates immediately.
    await refetch({ query: { disableCookieCache: true } })
    // Invalidate every cached tRPC response that resolves the
    // account's display name through `Account.name` — the previous
    // snapshot is now stale. This covers the account menu, group
    // lists, group detail (participants), members, expenses, balances,
    // activity feed, invitations, and stats.
    await Promise.all([
      utils.account.invalidate(),
      utils.groups.invalidate(),
      utils.invitations.invalidate(),
    ])
  }

  const updateProfile = trpc.account.updateProfile.useMutation({
    onSuccess: async () => {
      await refreshAccount()
      toast({ description: t('success') })
    },
  })
  const removeProfileImage = trpc.account.removeProfileImage.useMutation({
    onSuccess: refreshAccount,
  })
  const setProfileImage = trpc.account.setProfileImage.useMutation()
  const presignProfileImage = trpc.uploads.profileImagePresign.useMutation()

  // `name` is derived from `dirtyName ?? account?.name` so the input
  // automatically reflects the server-side value when the account loads
  // and keeps local edits intact once the user starts typing.

  if (isPending || !account) {
    return (
      <PageShell className="items-center justify-center py-4 sm:py-6">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </PageShell>
    )
  }

  function handleBack() {
    // Prefer browser history when available (e.g. arriving from the
    // account menu); fall back to the home page when the user landed
    // here directly (deep link, new tab, ...).
    if (typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back()
    } else {
      void navigate({ to: '/', replace: true })
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('errors.nameRequired'))
      return
    }
    if (trimmed.length < 2) {
      setError(t('errors.nameTooShort'))
      return
    }
    if (trimmed.length > 50) {
      setError(t('errors.nameTooLong'))
      return
    }
    setSubmitting(true)
    try {
      await updateProfile.mutateAsync({ name: trimmed })
    } catch {
      setError(t('errors.generic'))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleImageChange(file: File) {
    setError(null)
    setIsUploadingImage(true)
    try {
      const prepared = await prepareProfileImage(file)
      const { uploadUrl, fileUrl } = await presignProfileImage.mutateAsync({
        fileSize: prepared.size,
      })
      await uploadToPresignedUrl({
        uploadUrl,
        contentType: 'image/jpeg',
        body: prepared,
      })
      await setProfileImage.mutateAsync({ fileUrl })
      await refreshAccount()
      toast({ description: t('image.updated') })
    } catch {
      setError(t('errors.imageUpload'))
    } finally {
      setIsUploadingImage(false)
    }
  }

  async function handleRemoveImage() {
    setError(null)
    try {
      await removeProfileImage.mutateAsync()
      toast({ description: t('image.removed') })
    } catch {
      setError(t('errors.imageUpload'))
    }
  }

  const isDirty = name.trim() !== (account.name ?? '')

  return (
    <PageShell className="flex-col gap-6 py-4 sm:py-6">
      <h1 className="hidden items-center gap-2 text-2xl font-semibold sm:flex">
        <Button
          variant="ghost"
          size="icon"
          className="-ms-2"
          onClick={handleBack}
          title={tCommon('back')}
          aria-label={tCommon('back')}
        >
          <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
        </Button>
        {t('title')}
      </h1>
      <form className="flex flex-col gap-3" onSubmit={handleSubmit} noValidate>
        <SettingsSection
          id="profile"
          title={t('profile.title')}
          description={t('profile.description')}
          icon={UserRound as LucideIcon}
          footer={
            <>
              {error ? (
                <p className="w-full text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <Button
                type="submit"
                disabled={submitting || updateProfile.isPending || !isDirty}
              >
                {(submitting || updateProfile.isPending) && (
                  <Loader2 className="me-2 h-4 w-4 animate-spin" />
                )}
                {submitting || updateProfile.isPending
                  ? t('saving')
                  : t('submit')}
              </Button>
            </>
          }
        >
          <SettingsList className="border-t border-border/70">
            <SettingsRow
              id="profile-photo"
              label={t('image.label')}
              description={t('image.help')}
              control={
                <div className="flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                  <AccountAvatar
                    account={account}
                    size="xl"
                    className="shrink-0"
                  />
                  <div className="flex flex-wrap gap-2 sm:flex-1">
                    <FilePickerInput
                      ref={imageInputRef}
                      accept="image/*,.heic,.heif"
                      className="hidden"
                      onFilesSelected={([file]) => void handleImageChange(file)}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => imageInputRef.current?.click()}
                      disabled={
                        isUploadingImage || removeProfileImage.isPending
                      }
                    >
                      {isUploadingImage
                        ? t('image.uploading')
                        : t('image.choose')}
                    </Button>
                    {account.image ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void handleRemoveImage()}
                        disabled={
                          isUploadingImage || removeProfileImage.isPending
                        }
                      >
                        {t('image.remove')}
                      </Button>
                    ) : null}
                  </div>
                </div>
              }
            />
            <SettingsFieldRow
              id="account-settings-name"
              label={t('nameLabel')}
              control={
                <Input
                  id={settingsControlId('account-settings-name')}
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setDirtyName(e.target.value)}
                  required
                  maxLength={50}
                  className={cn('w-full sm:max-w-xs')}
                />
              }
            />
            <AccountEmailSettings
              email={account.email}
              isAnonymous={account.isAnonymous}
              onUpdated={refreshAccount}
            />
            <AccountPasswordSettings
              email={account.email}
              emailVerified={account.emailVerified}
              isAnonymous={account.isAnonymous}
              onUpdated={refreshAccount}
            />
            {account.isAnonymous ? <AnonymousAccountSettings /> : null}
          </SettingsList>
        </SettingsSection>
      </form>
      <AccountPreferences />
      <AuthorizedClients />
      <AccountExportModal />
      <NotificationsPreferences />
      <AccountAiPreferences />
    </PageShell>
  )
}
