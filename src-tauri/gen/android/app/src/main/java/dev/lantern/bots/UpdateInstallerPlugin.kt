package dev.lantern.bots

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.WebView
import android.widget.Toast
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class InstallArgs {
  var path: String = ""
}

/**
 * Installs Lantern updates (an APK the app downloaded and checked) with Android's package
 * installer. The first time, Android asks the user to confirm. On Android 12 and later, once
 * Lantern has installed itself this way, it is the app's installer of record and later updates
 * go in without a prompt.
 */
@TauriPlugin
class UpdateInstallerPlugin(private val activity: Activity) : Plugin(activity) {
  private val action = "${activity.packageName}.UPDATE_INSTALL_STATUS"
  private var resumed = true
  /** Android's confirmation, kept until the user is back in Lantern (apps can't open it from the background). */
  private var pendingConfirm: Intent? = null

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
        PackageInstaller.STATUS_PENDING_USER_ACTION -> {
          val confirm = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
          } else {
            @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
          }
          confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          if (resumed) confirm?.let { activity.startActivity(it) } else pendingConfirm = confirm
        }
        PackageInstaller.STATUS_SUCCESS -> Unit
        else -> {
          val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unknown error"
          Toast.makeText(activity, "Lantern couldn't update: $message", Toast.LENGTH_LONG).show()
        }
      }
    }
  }

  override fun onResume() {
    resumed = true
    pendingConfirm?.let { activity.startActivity(it) }
    pendingConfirm = null
  }

  override fun onPause() {
    resumed = false
  }

  override fun load(webView: WebView) {
    super.load(webView)
    val filter = IntentFilter(action)
    if (Build.VERSION.SDK_INT >= 33) {
      activity.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      activity.registerReceiver(receiver, filter)
    }
  }

  @Command
  fun status(invoke: Invoke) {
    val pm = activity.packageManager
    val installer = try {
      if (Build.VERSION.SDK_INT >= 30) {
        pm.getInstallSourceInfo(activity.packageName).installingPackageName
      } else {
        @Suppress("DEPRECATION") pm.getInstallerPackageName(activity.packageName)
      }
    } catch (e: Exception) {
      null
    }
    val ret = JSObject()
    ret.put("canInstall", Build.VERSION.SDK_INT < 26 || pm.canRequestPackageInstalls())
    ret.put("silent", Build.VERSION.SDK_INT >= 31 && installer == activity.packageName)
    ret.put("installer", installer ?: "")
    ret.put("sdk", Build.VERSION.SDK_INT)
    invoke.resolve(ret)
  }

  /** Opens the "Install unknown apps" switch for Lantern. */
  @Command
  fun openInstallSettings(invoke: Invoke) {
    activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
    invoke.resolve()
  }

  @Command
  fun install(invoke: Invoke) {
    val args = invoke.parseArgs(InstallArgs::class.java)
    // Copying the APK into the session takes a moment; keep it off the main thread.
    Thread {
      try {
        val file = File(args.path)
        val installer = activity.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(activity.packageName)
        if (Build.VERSION.SDK_INT >= 31) {
          params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
          file.inputStream().use { input ->
            session.openWrite("lantern.apk", 0, file.length()).use { output ->
              input.copyTo(output)
              session.fsync(output)
            }
          }
          var flags = PendingIntent.FLAG_UPDATE_CURRENT
          if (Build.VERSION.SDK_INT >= 31) flags = flags or PendingIntent.FLAG_MUTABLE
          val status = PendingIntent.getBroadcast(activity, sessionId, Intent(action).setPackage(activity.packageName), flags)
          session.commit(status.intentSender)
        }
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: e.toString())
      }
    }.start()
  }
}
