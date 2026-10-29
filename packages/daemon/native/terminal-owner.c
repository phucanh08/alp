/* ALP terminal owner protocol 1. Native-only spawn, lifetime acquisition, signals and reap.
 * Linux reduced-protection mode signals only its continuously owned unreaped root. See README.md for proof obligations and platform limits. */
#define _GNU_SOURCE
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <poll.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <time.h>
#ifdef __APPLE__
#include <util.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/mach_traps.h>
#include <mach/task_info.h>
/* Approved private ABI, XNU xnu-12377.1.9 bsd/sys/proc_info_private.h, flavor17.
 * Keep the complete 56-byte layout; parent identity is NEVER adoption authority. */
struct uniqinfo { uint8_t uuid[16]; uint64_t unique, parent; int32_t version, original_parent_version; uint64_t reserved[2]; };
_Static_assert(sizeof(struct uniqinfo) == 56, "private ABI size");
#else
#include <pty.h>
#include <dirent.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <linux/magic.h>
#endif
#define MAX_TRACKED 4096
#define QUEUE (1024 * 1024)
#ifndef START_TIMEOUT_MS
#define START_TIMEOUT_MS 3000
#endif
typedef struct {
  pid_t pid;
#ifdef __APPLE__
  uint64_t unique;
#else
  int fd;
#endif
} identity;
static identity known[MAX_TRACKED];
static size_t count;
static pid_t root;
static int scanning_failed, held = 1;
#ifndef __APPLE__
static int root_only, compatibility_available;
/* Exclusive natural parent retains this child (live or WNOWAIT zombie).
 * ECHILD revokes authority permanently; never infer ownership from a PID lookup. */
static int root_status(void) {
  if (!held || root <= 1) return 2;
  siginfo_t info = {0}; int result;
  do { result=waitid(P_PID,root,&info,WEXITED|WNOHANG|WNOWAIT); } while(result<0 && errno==EINTR);
  if(result<0) { if(errno==ECHILD) held=0; return 2; }
  return info.si_pid==root ? 0 : 1;
}
#endif
static long long clock_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (long long)t.tv_sec*1000+t.tv_nsec/1000000; }
static void event(const char *s) { (void)!write(3, s, strlen(s)); }
#ifdef __APPLE__
static int unique(pid_t p, struct uniqinfo *u) { memset(u, 0, sizeof(*u)); errno = 0; return proc_pidinfo(p, 17, 0, u, sizeof(*u)) == sizeof(*u) && u->unique != 0; }
static int token(pid_t p, audit_token_t *t) {
  mach_port_t task = MACH_PORT_NULL;
  if (task_name_for_pid(mach_task_self(), p, &task) != KERN_SUCCESS) return 0;
  mach_msg_type_number_t n = TASK_AUDIT_TOKEN_COUNT;
  kern_return_t r = task_info(task, TASK_AUDIT_TOKEN, (task_info_t)t, &n);
  mach_port_deallocate(mach_task_self(), task);
  return r == KERN_SUCCESS && n == TASK_AUDIT_TOKEN_COUNT && t->val[5] == (uint32_t)p;
}
static int acquire(pid_t p, identity *out, int session) {
  struct uniqinfo a, b; audit_token_t t;
  if (!held || !unique(p, &a)) return 0;
  if (session && getsid(p) != root) return 0;
  if (!token(p, &t) || !unique(p, &b) || a.unique != b.unique || t.val[7] != (uint32_t)b.version) return 0;
  out->pid = p; out->unique = a.unique; return 1;
}
/* 0 exited, 1 live, 2 uncertain. Never infer live from a failed task-port lookup. */
static int status(identity *id) {
  if (id->pid == root) { siginfo_t info = {0}; if (waitid(P_PID, root, &info, WEXITED|WNOHANG|WNOWAIT) == 0 && info.si_pid == root) return 0; }
  struct uniqinfo u; if (!unique(id->pid, &u)) return errno == ESRCH ? 0 : 2;
  if (u.unique != id->unique) return 0;
  struct proc_bsdinfo b;
  if (proc_pidinfo(id->pid, PROC_PIDTBSDINFO, 0, &b, sizeof(b)) != sizeof(b)) return 2;
  struct uniqinfo after; if (!unique(id->pid, &after)) return errno == ESRCH ? 0 : 2;
  if (after.unique != id->unique) return 0;
  return b.pbi_status == 5 /* SZOMB */ ? 0 : 1;
}
static void bound_signal(identity *id, int sig) {
  for (int tries = 0; tries < 4; tries++) {
    identity fresh; audit_token_t t; struct uniqinfo u;
    if (!acquire(id->pid, &fresh, 0) || fresh.unique != id->unique || !token(id->pid, &t) || !unique(id->pid, &u) || u.unique != id->unique || t.val[7] != (uint32_t)u.version) continue;
    int r = proc_signal_with_audittoken(&t, sig);
    if (r == 0 || r != ESRCH) return;
  }
}
static void remember(pid_t p) {
  identity id;
  if (!acquire(p, &id, 1)) return;
  for (size_t i=0; i<count; i++) if (known[i].unique == id.unique) return;
  if (count == MAX_TRACKED) { scanning_failed = 1; return; }
  known[count++] = id;
}
static void discover(void) {
  if (!held) return;
  int bytes = proc_listallpids(NULL, 0);
  if (bytes <= 0 || bytes > 1024*1024) { scanning_failed = 1; return; }
  /* proc_listallpids(NULL) returns estimated process COUNT, not bytes. */
  size_t capacity = (size_t)bytes + 256;
  pid_t *pids = calloc(capacity, sizeof(pid_t));
  if (!pids) { scanning_failed = 1; return; }
  int n = proc_listallpids(pids, (int)(capacity*sizeof(pid_t)));
  if (n < 0 || (size_t)n >= capacity) scanning_failed = 1;
  else for (int i=0; i<n; i++) if (pids[i]>1) remember(pids[i]);
  free(pids);
}
static int capability(void) {
  struct uniqinfo a, b; audit_token_t t;
  return unique(getpid(), &a) && token(getpid(), &t) && unique(getpid(), &b) && a.unique == b.unique && t.val[7] == (uint32_t)b.version;
}
#else
static int pid_signal(int fd, int sig) { return (int)syscall(SYS_pidfd_send_signal, fd, sig, NULL, 0); }
static int proc_stat(int dir, pid_t *sid, char *state) {
  int f = openat(dir, "stat", O_RDONLY|O_CLOEXEC); if (f < 0) return 0;
  char buf[8192]; ssize_t n = read(f, buf, sizeof(buf)-1); int saved=errno; close(f); errno=saved;
  if (n <= 0) { if(n==0) errno=EIO; return 0; } buf[n]=0;
  char *end = strrchr(buf, ')'); int pp, pg, s;
  if (!end || sscanf(end+1, " %c %d %d %d", state, &pp, &pg, &s) != 4) { errno=EIO; return 0; }
  *sid = (pid_t)s; return 1;
}
static int acquire(pid_t p, identity *out, int session) {
  if(root_only) { if(p!=root || root_status()==2) return 0; out->pid=root; out->fd=-1; return 1; }
  if (!held) return 0;
  char name[64]; snprintf(name, sizeof(name), "/proc/%d", p);
  int f=open(name, O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW); if (f<0) return 0;
  pid_t sid; char state;
  if (!proc_stat(f, &sid, &state) || (session && sid != root)) { close(f); return 0; }
  out->pid=p; out->fd=f; return 1;
}
static int status(identity *id) {
  if(root_only) return id->pid==root ? root_status() : 2;
  pid_t sid; char state;
  if (!proc_stat(id->fd, &sid, &state)) return errno == ENOENT || errno == ESRCH ? 0 : 2;
  return state == 'Z' || state == 'X' ? 0 : 1;
}
static void bound_signal(identity *id, int sig) {
  if(root_only) {
    if(id->pid!=root || root_status()!=1) return;
    /* No reap between waitid and kill: root PID remains continuously reserved. */
    int r; do { r=kill(root,sig); } while(r<0 && errno==EINTR);
    if(r<0 && errno!=ESRCH) scanning_failed=1;
    return;
  }
  (void)pid_signal(id->fd, sig);
}
static void remember(pid_t p) {
  identity id;
  if (!acquire(p, &id, 1)) return;
  struct stat st, old; if (fstat(id.fd,&st)) { close(id.fd); scanning_failed=1; return; }
  for (size_t i=0;i<count;i++) if (!fstat(known[i].fd,&old) && old.st_dev==st.st_dev && old.st_ino==st.st_ino) { close(id.fd); return; }
  if (count==MAX_TRACKED) { scanning_failed=1; close(id.fd); return; }
  known[count++]=id;
}
static void discover(void) {
  if (root_only || !held) return;
  DIR *d=opendir("/proc"); if (!d) { scanning_failed=1; return; }
  struct dirent *e;
  while ((e=readdir(d))) { char *end; long p=strtol(e->d_name,&end,10); if (*e->d_name && !*end && p>1 && p<=INT32_MAX) remember((pid_t)p); }
  closedir(d);
}
static int capability(void) {
  compatibility_available=0;
  /* Reject a proc mount in a different PID namespace (including numeric aliases).
   * The mount must be kernel procfs; /proc/self must report our local PID and SID. */
  int self=open("/proc/self",O_RDONLY|O_DIRECTORY|O_CLOEXEC);
  if(self<0) return 0;
  struct statfs fs; pid_t sid; char state;
  int statfd=openat(self,"stat",O_RDONLY|O_CLOEXEC); char buf[128]={0};
  ssize_t n=statfd<0?-1:read(statfd,buf,sizeof(buf)-1);
  if(statfd>=0) close(statfd);
  /* NSpid lists PIDs from the procfs PID namespace down to ours: exactly one field
   * proves this procfs is our active namespace (ancestor procfs => more fields;
   * unrelated procfs => no /proc/self). Needs no access to PID1; missing => deny. */
  int nspid_ok=0; int statusfd=openat(self,"status",O_RDONLY|O_CLOEXEC);
  if(statusfd>=0) {
    static char st[16384]; size_t len=0; ssize_t k;
    while(len<sizeof(st)-1 && ((k=read(statusfd,st+len,sizeof(st)-1-len))>0 || (k<0 && errno==EINTR))) if(k>0) len+=(size_t)k;
    close(statusfd); st[len]=0;
    char *line=strstr(st,"\nNSpid:");
    if(line && len<sizeof(st)-1) {
      line+=7; char *eol=strchr(line,'\n');
      if(eol) { *eol=0; int fields=0; long v=0; char *q=line, *end;
        for(;;) { while(*q==' '||*q=='\t') q++; if(!*q) break; errno=0; long x=strtol(q,&end,10); if(end==q||errno||(*end&&*end!=' '&&*end!='\t')) { fields=-1; break; } v=x; fields++; q=end; }
        nspid_ok=fields==1 && v==getpid(); }
    }
  }
  char link[32]; ssize_t ln=readlink("/proc/self",link,sizeof(link)-1);
  int link_ok=ln>0 && (link[ln]=0, strtol(link,NULL,10)==getpid());
  int namespace_ok=nspid_ok && link_ok && n>0 && strtol(buf,NULL,10)==getpid() && !fstatfs(self,&fs) && fs.f_type==PROC_SUPER_MAGIC && proc_stat(self,&sid,&state) && sid==getsid(0);
  close(self); if(!namespace_ok) return 0;
  identity id; pid_t saved=root; root=getsid(0);
  int ok=acquire(getpid(), &id, 1); root=saved;
  if (!ok) return 0;
  int r=pid_signal(id.fd, 0); int saved_errno=errno; close(id.fd);
  compatibility_available=r<0 && saved_errno==ENOSYS;
  return r==0;
}
#endif
static void signal_all(int sig) { for (size_t i=0;i<count;i++) if (status(&known[i]) != 0) bound_signal(&known[i], sig); }
static void nonblock(int f) { int flags=fcntl(f,F_GETFL); if(flags>=0) fcntl(f,F_SETFL,flags|O_NONBLOCK); }
static void close_extra(void) {
#ifdef __APPLE__
  int n = getdtablesize();
  for(int i=3;i<n;i++) close(i);
#else
  long n=sysconf(_SC_OPEN_MAX); if(n<0) n=65536;
  for(int i=3;i<n;i++) close(i);
#endif
}
/* Startup failure owns the unreaped root but must never wait indefinitely.
 * Gate EOF prevents exec. All optional signals still use a verified identity. */
static int abort_start(int master, int gate) {
  close(gate);
  identity id;
  if(acquire(root,&id,0)) {
    bound_signal(&id,SIGKILL);
#ifndef __APPLE__
    if(id.fd>=0) close(id.fd);
#endif
  }
  long long deadline=clock_ms()+250; int reaped=0;
  do {
    siginfo_t info={0};
    if(waitid(P_PID,root,&info,WEXITED|WNOHANG|WNOWAIT)==0 && info.si_pid==root) { int r; do { r=waitpid(root,NULL,WNOHANG); } while(r<0 && errno==EINTR); reaped=r==root; break; }
    usleep(1000);
  } while(clock_ms()<deadline);
  held=0; close(master);
  event("{\"error\":\"native_identity_unavailable\"}\n");
  char message[160]; snprintf(message,sizeof(message),"{\"cleanup\":true,\"observed\":1,\"live\":0,\"uncertain\":%d}\n",reaped?0:1); event(message);
  return 78;
}
int main(int argc, char **argv) {
  signal(SIGPIPE,SIG_IGN);
  struct sigaction child_action; memset(&child_action,0,sizeof(child_action));
  child_action.sa_handler=SIG_DFL; sigemptyset(&child_action.sa_mask);
  if(sigaction(SIGCHLD,&child_action,NULL)) return 71;
  int capable=capability();
#ifndef __APPLE__
  if(argc==2 && !strcmp(argv[1],"--capability") && compatibility_available) { puts("alp-terminal-owner:1:root-only"); return 0; }
  if(argc>1 && !strcmp(argv[1],"--root-only")) { root_only=1; argc--; argv++; }
  if(argc>=6 && ((root_only && !compatibility_available) || (!root_only && !capable && compatibility_available))) {
    event(!root_only ? "{\"refused\":\"terminal_protection_ack_required\"}\n" : "{\"refused\":\"terminal_unsupported\"}\n");
    event("{\"cleanup\":true,\"observed\":0,\"live\":0,\"uncertain\":0}\n"); return 78;
  }
#endif
  if (argc==2 && !strcmp(argv[1],"--capability")) { if (!capable) return 78; puts("alp-terminal-owner:1"); return 0; }
  if (argc<6 || (!capable
#ifndef __APPLE__
    && !(root_only && compatibility_available)
#endif
  )) { event("{\"refused\":\"terminal_unsupported\"}\n"); event("{\"cleanup\":true,\"observed\":0,\"live\":0,\"uncertain\":0}\n"); return 78; }
  int cols=atoi(argv[1]),rows=atoi(argv[2]),grace=atoi(argv[3]);
  if(cols<1 || cols>1000 || rows<1 || rows>1000 || grace<0 || grace>10000) return 64;
  unsigned char *out=malloc(QUEUE),*input=malloc(QUEUE);
  if(!out || !input) { free(out); free(input); return 71; }
  int gate[2],started[2]; if(pipe(gate)||pipe(started)) return 71;
  struct winsize ws={.ws_col=(unsigned short)cols,.ws_row=(unsigned short)rows}; int master;
  root=forkpty(&master,NULL,NULL,&ws);
  if (root<0) return 71;
  if (!root) {
    close(gate[1]); close(started[0]);
    char ready=getsid(0)==getpid()?'S':'E';
    if(write(started[1],&ready,1)!=1) _exit(126);
    char release=0; if(read(gate[0],&release,1)!=1 || release!='G' || ready!='S') _exit(126);
    close_extra(); signal(SIGPIPE,SIG_DFL);
    if(chdir(argv[4])) _exit(126);
    execv(argv[5],&argv[5]); _exit(127);
  }
  close(gate[0]); close(started[1]); char ready=0;
  struct pollfd startup[3]={{started[0],POLLIN,0},{0,0,0},{4,POLLIN,0}};
  int available=poll(startup,3,START_TIMEOUT_MS);
  int startok=available>0 && !(startup[1].revents&(POLLHUP|POLLERR)) && !(startup[2].revents&(POLLIN|POLLHUP|POLLERR)) && (startup[0].revents&POLLIN) && read(started[0],&ready,1)==1 && ready=='S';
  close(started[0]);
  identity first;
  if(!startok || !acquire(root,&first,1)) return abort_start(master,gate[1]);
  known[count++]=first;
  if(write(gate[1],"G",1)!=1) return abort_start(master,gate[1]);
  close(gate[1]);
  char msg[256]; snprintf(msg,sizeof(msg),"{\"ready\":%d,\"protocol\":1}\n",root); event(msg);
  nonblock(master); nonblock(0); nonblock(1); nonblock(4);
  size_t outn=0,inn=0; char commands[256]; size_t cn=0;
  int cleaning=0, root_notified=0, code=0, sig=0, io_failed=0; long long start=0, lastscan=0;
  for (;;) {
    long long now=clock_ms();
    if(now-lastscan>=20) { discover(); lastscan=now; }
    siginfo_t info={0};
    if(!root_notified && waitid(P_PID,root,&info,WEXITED|WNOHANG|WNOWAIT)==0 && info.si_pid==root) {
      root_notified=1; code=info.si_code==CLD_EXITED?info.si_status:0; sig=info.si_code==CLD_EXITED?0:info.si_status;
      snprintf(msg,sizeof(msg),"{\"exitCode\":%d,\"signal\":%d}\n",code,sig); event(msg); cleaning=cleaning?cleaning:1;
    }
    if(io_failed && !cleaning) cleaning=1;
    if(cleaning==1) { start=now; discover(); signal_all(SIGHUP); cleaning=2; }
    if(cleaning>=2 && now-start>=grace) { discover(); signal_all(SIGKILL); cleaning=3; }
    if(cleaning==3 && now-start>=grace+250) break;
    struct pollfd fds[4]={{0,inn<QUEUE?POLLIN:0,0},{master,(short)((outn<QUEUE?POLLIN:0)|(inn?POLLOUT:0)),0},{1,outn?POLLOUT:0,0},{4,POLLIN,0}};
    if(poll(fds,4,10)<0 && errno!=EINTR) { io_failed=1; continue; }
    if(fds[0].revents&POLLIN) { ssize_t n=read(0,input+inn,QUEUE-inn); if(n>0) inn+=(size_t)n; else if(n==0) cleaning=cleaning?cleaning:1; }
    if(fds[0].revents&(POLLHUP|POLLERR)) cleaning=cleaning?cleaning:1;
    if(fds[1].revents&POLLIN) { ssize_t n=read(master,out+outn,QUEUE-outn); if(n>0) outn+=(size_t)n; }
    if(fds[1].revents&POLLOUT) { ssize_t n=write(master,input,inn); if(n>0) {inn-=(size_t)n;memmove(input,input+n,inn);} }
    if(fds[2].revents&POLLOUT) { ssize_t n=write(1,out,outn); if(n>0) {outn-=(size_t)n;memmove(out,out+n,outn);} else if(errno!=EAGAIN&&errno!=EINTR) io_failed=1; }
    if(fds[2].revents&(POLLHUP|POLLERR)) io_failed=1;
    if(fds[3].revents&POLLIN) {
      char b[128]; ssize_t n=read(4,b,sizeof(b));
      for(ssize_t i=0;i<n;i++) { if(b[i]=='\n') { commands[cn]=0; int c,r; if(!strcmp(commands,"C")) cleaning=cleaning?cleaning:1; else if(sscanf(commands,"R %d %d",&c,&r)==2 && c>0&&c<=1000&&r>0&&r<=1000) { ws.ws_col=(unsigned short)c;ws.ws_row=(unsigned short)r; ioctl(master,TIOCSWINSZ,&ws); } cn=0; } else if(cn<sizeof(commands)-1) commands[cn++]=b[i]; else {io_failed=1;cn=0;} }
    }
    if(fds[3].revents&(POLLHUP|POLLERR)) cleaning=cleaning?cleaning:1;
  }
  /* Last scan and verification happen BEFORE final root reap: SID still reserved. */
  discover(); signal_all(SIGKILL); usleep(20000);
  int live=0,uncertain=scanning_failed;
  for(size_t i=0;i<count;i++) { int s=status(&known[i]); if(s==1) live++; else if(s==2) uncertain++; }
  siginfo_t final={0};
  if(waitid(P_PID,root,&final,WEXITED|WNOHANG|WNOWAIT)==0 && final.si_pid==root) {
    int reaped; do { reaped=waitpid(root,NULL,WNOHANG); } while(reaped<0 && errno==EINTR);
    if(reaped!=root) uncertain++;
    held=0;
  } else { /* Never blocking reap of a live/unverifiable root; no adoption after this point. */
    held=0; uncertain++;
  }
  /* Drain all remaining PTY output and queued bytes, advancing partial writes.
   * A stalled consumer cannot retain an owner indefinitely: undrained output is
   * explicit uncertainty, NEVER a successful silent tail discard. No discovery
   * or signals occur after final root reap above. */
  long long drain_deadline=clock_ms()+1000; int master_eof=0;
  while((!master_eof || outn) && clock_ms()<drain_deadline) {
    struct pollfd drain[2]={{master,(!master_eof && outn<QUEUE)?POLLIN:0,0},{1,outn?POLLOUT:0,0}};
    if(poll(drain,2,10)<0) { if(errno==EINTR) continue; io_failed=1; break; }
    if(!master_eof && outn<QUEUE && (drain[0].revents&(POLLIN|POLLHUP|POLLERR))) {
      ssize_t n=read(master,out+outn,QUEUE-outn);
      if(n>0) outn+=(size_t)n;
      else if(n==0 || errno==EIO) master_eof=1;
      else if(errno!=EAGAIN && errno!=EINTR) { io_failed=1; master_eof=1; }
    }
    if(outn && (drain[1].revents&POLLOUT)) {
      ssize_t n=write(1,out,outn);
      if(n>0) { outn-=(size_t)n; memmove(out,out+n,outn); }
      else if(errno!=EAGAIN && errno!=EINTR) { io_failed=1; break; }
    }
    if(drain[1].revents&(POLLHUP|POLLERR)) { io_failed=1; break; }
  }
  int limited_coverage=0;
#ifndef __APPLE__
  limited_coverage=root_only;
#endif
  /* An unmanaged descendant may retain the PTY indefinitely. Report this known
   * coverage limit separately. Queued/lost bytes and adapter faults still fail. */
  if(outn || (!master_eof && !limited_coverage)) io_failed=1;
  close(master);
  uncertain+=io_failed;
  const char *coverage="";
#ifndef __APPLE__
  if(root_only) coverage=master_eof ? ",\"coverage\":\"root-only\",\"outputOpen\":false" : ",\"coverage\":\"root-only\",\"outputOpen\":true";
#endif
  snprintf(msg,sizeof(msg),"{\"cleanup\":true,\"observed\":%zu,\"live\":%d,\"uncertain\":%d%s}\n",count,live,uncertain,coverage); event(msg);
#ifndef __APPLE__
  for(size_t i=0;i<count;i++) if(known[i].fd>=0) close(known[i].fd);
#endif
  free(out);free(input); return live||uncertain?2:0;
}
