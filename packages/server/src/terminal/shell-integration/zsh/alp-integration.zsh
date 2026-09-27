if [[ -n "${_ALP_ZSH_INTEGRATION_LOADED-}" ]]; then
  return
fi
typeset -g _ALP_ZSH_INTEGRATION_LOADED=1

autoload -Uz add-zsh-hook

typeset -g _ALP_ZSH_COMMAND_ACTIVE=0

function _alp_osc633() {
  printf '\e]633;%s\a' "$1"
}

function _alp_precmd() {
  local command_status=$?
  if [[ "$_ALP_ZSH_COMMAND_ACTIVE" == "1" ]]; then
    _alp_osc633 "D;${command_status}"
    _ALP_ZSH_COMMAND_ACTIVE=0
  fi
  printf '\e]2;%s\a' "${PWD/#$HOME/~}"
  _alp_osc633 "A"
}

function _alp_preexec() {
  _ALP_ZSH_COMMAND_ACTIVE=1
  _alp_osc633 "B"
  _alp_osc633 "C"
  printf '\e]2;%s\a' "$1"
}

add-zsh-hook precmd _alp_precmd
add-zsh-hook preexec _alp_preexec
