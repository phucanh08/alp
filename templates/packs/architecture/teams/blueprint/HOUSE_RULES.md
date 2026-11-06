Quy ước của Blueprint (thêm vào phần hướng dẫn của từng role):

- Trước khi một feature đi qua ranh giới module, lead hỏi architect xem nó có hợp
  không và dependency phải trỏ theo hướng nào; architect tư vấn chứ không bao giờ
  phê duyệt. Mọi ngoại lệ do main quyết (hoặc người dùng, khi main hỏi), và quyết
  định đó phải được ghi lại.
- Peer làm theo skill feature-architecture và khi handoff thì kèm output của phần
  kiểm ranh giới (boundary check) của project. Check fail thì sửa, không đi vòng.
- Khi một thay đổi làm đổi ranh giới, contract, public API hay đường migration, lead
  giao brief cho docs-maintainer kèm các đường dẫn đã đổi; thay đổi nội bộ nhỏ thì
  không cần sửa tài liệu.
- Reviewer review diff cuối một cách độc lập, gồm cả bằng chứng về ranh giới.
