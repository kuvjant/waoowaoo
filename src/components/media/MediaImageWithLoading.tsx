'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { MediaImage, type MediaImageProps } from './MediaImage'

type MediaImageWithLoadingProps = MediaImageProps & {
  containerClassName?: string
  skeletonClassName?: string
  keepSkeletonOnError?: boolean
  showLoadingIndicator?: boolean
  loadingIndicatorClassName?: string
  /** 图片加载失败时显示的提示（如网络/存储问题） */
  errorHint?: ReactNode
}

function mergeClassNames(...classNames: Array<string | undefined | false>): string {
  return classNames.filter(Boolean).join(' ')
}

export function MediaImageWithLoading({
  src,
  alt,
  className,
  containerClassName,
  skeletonClassName,
  keepSkeletonOnError = false,
  showLoadingIndicator = true,
  loadingIndicatorClassName,
  errorHint,
  onLoad,
  onError,
  ...restProps
}: MediaImageWithLoadingProps) {
  const [isLoaded, setIsLoaded] = useState(false)
  const [isError, setIsError] = useState(false)

  useEffect(() => {
    setIsLoaded(false)
    setIsError(false)
  }, [src])

  if (!src) return null

  const shouldShowSkeleton = !isLoaded && (!isError || keepSkeletonOnError)
  const showErrorHint = isError && errorHint

  const imageClassName = mergeClassNames(
    className,
    'transition-opacity duration-200',
    shouldShowSkeleton ? 'opacity-0' : 'opacity-100',
  )

  const handleLoad: NonNullable<MediaImageProps['onLoad']> = (event) => {
    setIsLoaded(true)
    onLoad?.(event)
  }

  const handleError: NonNullable<MediaImageProps['onError']> = (event) => {
    setIsError(true)
    setIsLoaded(true)
    onError?.(event)
  }

  return (
    <div className={mergeClassNames('relative overflow-hidden bg-[var(--glass-bg-muted)]', containerClassName)}>
      {shouldShowSkeleton && (
        <div
          className={mergeClassNames(
            'pointer-events-none absolute inset-0 z-0 animate-pulse bg-[var(--glass-bg-muted)]',
            skeletonClassName,
          )}
        />
      )}
      {shouldShowSkeleton && showLoadingIndicator && (
        <div
          className={mergeClassNames(
            'pointer-events-none absolute inset-0 z-[1] flex items-center justify-center',
            loadingIndicatorClassName,
          )}
        >
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--glass-stroke-strong)] border-t-[var(--glass-tone-info-fg)]" />
          <span className="sr-only">Loading</span>
        </div>
      )}
      <MediaImage
        src={src}
        alt={alt}
        className={imageClassName}
        onLoad={handleLoad}
        onError={handleError}
        {...restProps}
      />
      {showErrorHint && (
        <div className="absolute inset-0 z-[2] flex flex-col items-center justify-center bg-[var(--glass-overlay)] p-2 text-center">
          <span className="text-xs text-[var(--glass-tone-danger-fg)]">{errorHint}</span>
        </div>
      )}
    </div>
  )
}
