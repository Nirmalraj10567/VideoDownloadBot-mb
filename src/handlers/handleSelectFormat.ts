import { InputFile } from 'grammy'
import { ShortFormatModel } from '@/models/ShortFormat'
import { ShortUrlModel } from '@/models/ShortUrl'
import {
  deleteDownloadJob,
  findOrCreateDownloadJob,
} from '@/models/DownloadJob'
import { findOrCreateUrl, findUrl } from '@/models/Url'
import Context from '@/models/Context'
import bot from '@/helpers/bot'
import report from '@/helpers/report'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const youtubedl = require('youtube-dl-exec')

export default async function handleSelectFormat(ctx: Context) {
  // Let users know not to panic after a minute of downloading
  const stillDownloadingTimeout = setTimeout(
    () => ctx.editMessageText(ctx.i18n.t('still_downloading')),
    1000 * 60 // 1 minute
  )
  let formatId: string
  let url: string
  let created = false
  try {
    // Answer the query to remove the waiting ui on Telegram
    await ctx.answerCallbackQuery()
    // Make user know that the file is being downloaded
    await ctx.editMessageText(ctx.i18n.t('downloading'))
    const data = ctx.callbackQuery.data.split('~')
    formatId = data[0]
    url = (await ShortUrlModel.findOne({ shortId: data[1] })).url
    if (formatId.length > 9) {
      formatId = (await ShortFormatModel.findOne({ shortId: formatId }))
        .formatId
    }
    // Create caption
    const caption = ctx.i18n.t('video_caption', {
      bot: bot.botInfo.username,
    })
    // Find url in cache, if it exists, send it instead
    const cachedUrl = await findUrl(url, formatId)
    if (cachedUrl) {
      await ctx.editMessageText(ctx.i18n.t('download_complete'))
      return ctx.replyWithVideo(cachedUrl.fileId, {
        reply_to_message_id: ctx.callbackQuery.message.message_id,
        caption,
        parse_mode: 'HTML',
      })
    }
    const findOrCreateResult = await findOrCreateDownloadJob(
      ctx.dbchat.telegramId,
      ctx.callbackQuery.message.message_id,
      url,
      formatId
    )
    created = findOrCreateResult.created
    const downloadJob = findOrCreateResult.doc
    if (!created) {
      if (downloadJob.messageId === ctx.callbackQuery.message.message_id) {
        return
      }
      return ctx.editMessageText(ctx.i18n.t('error_already_in_progress'))
    }
    // Get the video info again
    const videoInfo = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificate: true,
      youtubeSkipDashManifest: true,
      skipDownload: true,
      format: formatId,
    })
    const chosenFormat = videoInfo.formats.find(
      (format) => format.format_id === formatId
    )
    if (!chosenFormat) {
      throw new Error(`Chosen format ${formatId} does not exist at url ${url}`)
    }
    const inputFile = new InputFile({ url: chosenFormat.url })
    const file = await ctx.replyWithVideo(inputFile, {
      reply_to_message_id: ctx.callbackQuery.message.message_id,
      caption,
      parse_mode: 'HTML',
    })
    // Cache the url and file id
    const createdUrl = await findOrCreateUrl(url, file.video, formatId)
    console.log(createdUrl)
    // Edit the "downloading" message
    await ctx.editMessageText(ctx.i18n.t('download_complete'))
  } catch (error) {
    // Report the error to the admin
    report(error, { ctx, location: 'handleSelectFormat' })
    try {
      // Report the error to the user
      await ctx.editMessageText(ctx.i18n.t('error'))
      await ctx.reply(ctx.i18n.t('error_message'), {
        reply_to_message_id: ctx.callbackQuery.message.message_id,
      })
    } catch (error) {
      report(error, {
        ctx,
        location: 'showing error to user at handleSelectFormat',
      })
    }
  } finally {
    // No need to change the message so that user wouldn't panic anymore
    clearTimeout(stillDownloadingTimeout)
    // Remove the download job
    if (created && url && formatId) {
      await deleteDownloadJob(ctx.dbchat.telegramId, url, formatId)
    }
  }
}
