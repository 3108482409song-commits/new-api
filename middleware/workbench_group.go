package middleware

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

// WorkbenchGroup applies the billing group selected in the workbench UI to the
// current request before channel selection runs. The group travels in the
// X-Workbench-Group header so it never leaks into upstream request bodies
// (JSON or multipart). It must run after UserAuth (which puts the user's own
// group into ContextKeyUserGroup) and before Distribute.
func WorkbenchGroup() func(c *gin.Context) {
	return func(c *gin.Context) {
		group := c.GetHeader("X-Workbench-Group")
		if group == "" {
			return
		}
		userGroup := common.GetContextKeyString(c, constant.ContextKeyUserGroup)
		usingGroup := common.GetContextKeyString(c, constant.ContextKeyUsingGroup)
		if group == usingGroup {
			return
		}
		if !service.GroupInUserUsableGroups(userGroup, group) {
			abortWithOpenAiMessage(c, http.StatusForbidden, i18n.T(c, i18n.MsgDistributorGroupAccessDenied))
			return
		}
		common.SetContextKey(c, constant.ContextKeyUsingGroup, group)
	}
}
